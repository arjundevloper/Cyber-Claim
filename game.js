/* =============================================================
   TERRITORY.IO  —  Multiplayer Client  (FIXED)
   ============================================================= */

// ▼▼▼ CHANGE THIS to your Render server URL ▼▼▼
const SERVER_URL = 'https://cyber-claim.onrender.com';

// ─── Constants (must match server) ───────────────────────────
const CELL   = 20;
const COLS   = 200;
const ROWS   = 200;
const W      = COLS * CELL;
const H      = ROWS * CELL;
const CX     = W / 2;
const CY     = H / 2;
const RADIUS = Math.min(W, H) / 2 - CELL;

const SPEED          = 2.6;
const TRAIL_DIST     = 6;
const START_HALF     = 5;

const POWERUP_PICKUP_R = 20;
const POWERUP_HEX_SIZE = 18;
const POWERUP_RESPAWN  = 22000;
const POWERUP_DESPAWN  = 12000;

const POWERUP_TYPES = {
  overcharge: {
    weight:3, duration:8000,
    color:'#ffd700', glowColor:'#ffaa00', icon:'⚡', label:'Overcharge', rarity:'Rare',
    speedMult:1.4, steerMult:0.55, scoreMult:2, trailDistMult:0.5,
    trailGlow:true, phantomTrail:false, shieldHit:false, bigGlow:false,
  },
  shield: {
    weight:3, duration:Infinity,
    color:'#4fc3f7', glowColor:'#0288d1', icon:'🛡', label:'Guardian Shield', rarity:'Rare',
    speedMult:1, steerMult:1, scoreMult:1, trailDistMult:1,
    trailGlow:false, phantomTrail:false, shieldHit:true, bigGlow:true,
  },
  phantom: {
    weight:2, duration:6000,
    color:'#ce93d8', glowColor:'#9c27b0', icon:'👻', label:'Phantom Trail', rarity:'Epic',
    speedMult:0.8, steerMult:1, scoreMult:1, trailDistMult:1,
    trailGlow:false, phantomTrail:true, shieldHit:false, bigGlow:false,
  },
};

let PLAYER_COLORS = [
  { fill:'#00b8d4', glow:'#00e5ff', trail:'#00e5ff' },
  { fill:'#e53935', glow:'#ff5252', trail:'#ff5252' },
  { fill:'#43a047', glow:'#69f0ae', trail:'#69f0ae' },
  { fill:'#fb8c00', glow:'#ffb300', trail:'#ffb300' },
  { fill:'#8e24aa', glow:'#ea80fc', trail:'#ea80fc' },
  { fill:'#00897b', glow:'#64ffda', trail:'#64ffda' },
  { fill:'#f06292', glow:'#ff80ab', trail:'#ff80ab' },
  { fill:'#fdd835', glow:'#ffff00', trail:'#ffff00' },
  { fill:'#5e35b1', glow:'#b388ff', trail:'#b388ff' },
  { fill:'#6d4c41', glow:'#bcaaa4', trail:'#bcaaa4' },
];

const C_BG   = '#07090f';
const C_GRID = 'rgba(255,255,255,0.025)';

// ─── Canvas / context ─────────────────────────────────────────
const canvas = document.getElementById('gameCanvas');
const ctx    = canvas.getContext('2d');

const tCanvas       = document.createElement('canvas');
tCanvas.width       = W; tCanvas.height = H;
const tCtx          = tCanvas.getContext('2d');

const mmSize        = 160;
const mmCanvas      = document.createElement('canvas');
mmCanvas.width      = mmSize; mmCanvas.height = mmSize;
const mmCtx         = mmCanvas.getContext('2d');
let   mmDirty       = true;

// ─── Shared grid ──────────────────────────────────────────────
const grid = new Uint8Array(COLS * ROWS);

function gi(c,r)          { return r*COLS+c; }
function inBounds(c,r)    { return c>=0&&c<COLS&&r>=0&&r<ROWS; }
function getG(c,r)        { return inBounds(c,r)?grid[gi(c,r)]:0; }
function worldToCell(x,y) { return [Math.floor(x/CELL), Math.floor(y/CELL)]; }

// ─── Multiplayer state ────────────────────────────────────────
let socket    = null;
let myId      = null;
let mySlot    = 0;
let connected = false;

// All remote players keyed by socket id
const remotePlayers = new Map();

// Local player — movement is predicted locally, server is authoritative on captures/kills
const player = {
  x:CX, y:CY, angle:0,
  trail:[], outside:false,
  slot:0,
};

// ─── Kill feed ────────────────────────────────────────────────
const killFeed = [];
const KILLFEED_DURATION = 5000;

function addKillFeed(text, color='#fff') {
  killFeed.unshift({ text, color, ts:Date.now() });
  if (killFeed.length > 6) killFeed.pop();
}

// ─── Leaderboard ──────────────────────────────────────────────
let leaderboard = [];

// ─── Score ────────────────────────────────────────────────────
let ownedCells        = 0;
let territoryScore    = 0;
let totalOwnableCells = 0;
for (let r=0;r<ROWS;r++) for (let c=0;c<COLS;c++) {
  const wx=(c+0.5)*CELL, wy=(r+0.5)*CELL;
  if(Math.hypot(wx-CX,wy-CY)<=RADIUS) totalOwnableCells++;
}

// ─── Powerup ──────────────────────────────────────────────────
const powerup = { x:0, y:0, active:false, type:null, despawnTimer:POWERUP_DESPAWN };
const effect  = { type:null, remaining:0 };

// ─── Camera / input ───────────────────────────────────────────
const camera = { x:0, y:0 };
const input  = { x:0, y:0, active:false };
const cursor = { x:-999, y:-999 };
const joy    = { active:false, startX:0, startY:0, dx:0, dy:0 };

// ─── FX ───────────────────────────────────────────────────────
let globalTime=0, lastTime=0, fps=0, fpsAccum=0, fpsFrames=0;
const pulses     = [];
const flashAlpha = { v:0 };

// ─── DOM refs ─────────────────────────────────────────────────
const elScore    = document.getElementById('score-display');
const elPct      = document.getElementById('pct-display');
const elFps      = document.getElementById('d-fps');
const elPos      = document.getElementById('d-pos');
const elTrail    = document.getElementById('d-trail');
const elOwned    = document.getElementById('d-owned');
const elState    = document.getElementById('d-state');
const elHint     = document.getElementById('hint');
const elBoostHud = document.getElementById('boost-hud');
const elBoostTimer = document.getElementById('boost-timer');
const elFlash    = document.getElementById('capture-flash');
// injected later:
let elKillfeed   = null;
let elLeaderboard= null;
let elConnStatus = null;
let elPlayerCount= null;

// ─── Socket connection ────────────────────────────────────────
function connectSocket() {
  const script   = document.createElement('script');
  script.src     = SERVER_URL + '/socket.io/socket.io.js';
  script.onload  = () => initSocket();
  script.onerror = () => {
    if (elConnStatus) { elConnStatus.textContent='Server unreachable'; elConnStatus.style.color='#ff5252'; }
  };
  document.head.appendChild(script);
}

function initSocket() {
  // FIX: guard against calling this multiple times (was possible if script loaded twice)
  if (socket) return;

  socket = io(SERVER_URL, { transports:['websocket','polling'] });

  socket.on('connect', () => {
    connected = true;
    if (elConnStatus) { elConnStatus.textContent='Connected'; elConnStatus.style.color='#69f0ae'; }
  });

  socket.on('disconnect', () => {
    connected = false;
    if (elConnStatus) { elConnStatus.textContent='Disconnected'; elConnStatus.style.color='#ff5252'; }
  });

  socket.on('roomFull', () => alert('Server is full (10 players max). Try again later!'));

  socket.on('init', data => {
    myId   = data.myId;
    mySlot = data.mySlot;
    if (data.colors) PLAYER_COLORS = data.colors;

    // Load grid
    const buf = Uint8Array.from(atob(data.grid), c=>c.charCodeAt(0));
    grid.set(buf);
    redrawTerritoryCanvas();
    mmDirty = true;

    // Self — use server position
    player.slot    = mySlot;
    player.outside = false;
    player.trail   = [];
    const myStart  = data.players.find(p=>p.id===myId);
    if (myStart) { player.x=myStart.x; player.y=myStart.y; player.angle=myStart.angle; }

    // Remote players
    remotePlayers.clear();
    for (const rp of data.players) {
      if (rp.id !== myId) remotePlayers.set(rp.id, rp);
    }

    if (data.powerup) Object.assign(powerup, data.powerup);

    recalcOwnedCells();
    if (elPlayerCount) elPlayerCount.textContent = data.players.length + '/10';

    // FIX: prompt for name AFTER we have a socket id (was using setTimeout(1200) which
    //      raced against async script load and sometimes fired before socket was ready)
    promptName();
  });

  socket.on('playerJoined', data => {
    // FIX: server now sends correct socket id; just store it directly
    if (data.id !== myId) remotePlayers.set(data.id, data);
    addKillFeed(`${data.name} joined`, '#aaa');
    if (elPlayerCount) elPlayerCount.textContent = (remotePlayers.size+1) + '/10';
  });

  socket.on('playerLeft', data => {
    const rp = remotePlayers.get(data.id);
    if (rp) addKillFeed(`${rp.name} left`, '#888');
    remotePlayers.delete(data.id);
    if (elPlayerCount) elPlayerCount.textContent = (remotePlayers.size+1) + '/10';
  });

  socket.on('playerPositions', list => {
  for (const rp of list) {
    if (rp.id === myId) {
      // Reconciliation - smooth correction
      player.x = player.x * 0.6 + rp.x * 0.4;
      player.y = player.y * 0.6 + rp.y * 0.4;
      player.angle = lerpAngle(player.angle, rp.angle, 0.4);

      player.outside = rp.outside;
      if (!rp.outside) player.trail = [];
    } else {
      remotePlayers.set(rp.id, rp);
    }
  }
});

let lastRedraw = 0;
  socket.on('gridUpdate', b64 => {
  const now = Date.now();
  if (now - lastRedraw < 80) return; // throttle heavy redraw
  lastRedraw = now;

  const buf = Uint8Array.from(atob(b64), c=>c.charCodeAt(0));
  grid.set(buf);
  redrawTerritoryCanvas();
  mmDirty = true;
  recalcOwnedCells();
});;

  socket.on('leaderboard', data => {
    leaderboard = data;
    // FIX: update score from leaderboard (server is authoritative on score)
    const mine = leaderboard.find(e=>e.id===myId);
    if (mine) territoryScore = mine.score;
    renderLeaderboardDOM();
  });

  socket.on('playerKilled', data => {
    const { victimName, killerName, killerSlot, victimId, reason } = data;
    const kColor = killerSlot !== undefined ? (PLAYER_COLORS[killerSlot]?.trail||'#fff') : '#fff';
    let msg='';
    if      (reason==='self')       msg=`${victimName} cut their own trail`;
    else if (reason==='trail_cut')  msg=`${killerName} cut ${victimName}'s trail`;
    else                            msg=`${victimName} was eliminated`;
    addKillFeed(msg, kColor);

    if (victimId === myId) {
      // Server respawned us — reset local prediction state
      player.outside = false;
      player.trail   = [];
      const sp = getStartPos(mySlot);
      player.x=sp.x; player.y=sp.y; player.angle=0;
      flashAlpha.v = 0.9;
    }
  });

  socket.on('powerupState', data => {
    Object.assign(powerup, data);
  });

  socket.on('powerupPickup', data => {
    if (data.playerId === myId) {
      const def        = POWERUP_TYPES[data.powerupType];
      effect.type      = data.powerupType;
      effect.remaining = def.duration;
      flashAlpha.v     = 0.55;
    }
  });
}

// ─── Name prompt ──────────────────────────────────────────────
let _namePrompted = false;
function promptName() {
  if (_namePrompted || !socket) return;
  _namePrompted = true;

  const modal = document.createElement('div');
  modal.style.cssText = `
    position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
    background:rgba(7,9,20,0.95); border:2px solid #00e5ff; padding:30px 40px;
    border-radius:12px; color:#fff; font-family:system-ui; z-index:1000;
    text-align:center; box-shadow:0 0 40px rgba(0,229,255,0.3);
  `;
  modal.innerHTML = `
    <div style="font-size:18px;margin-bottom:16px">Enter your name</div>
    <input id="nameInput" maxlength="16" value="Player" style="padding:10px 16px;font-size:18px;width:220px;background:#111;border:1px solid #00e5ff;color:#fff;border-radius:6px;">
    <br><button id="nameBtn" style="margin-top:16px;padding:10px 32px;background:#00e5ff;color:#000;border:none;border-radius:6px;font-weight:700;cursor:pointer;">Join</button>
  `;
  document.body.appendChild(modal);

  const input = modal.querySelector('#nameInput');
  const btn = modal.querySelector('#nameBtn');

  const submit = () => {
    const name = input.value.trim().slice(0,16) || 'Player';
    if (socket && connected) socket.emit('setName', name);
    modal.remove();
  };

  btn.onclick = submit;
  input.focus();
  input.onkeydown = e => { if (e.key === 'Enter') submit(); };
}

// ─── Start positions ──────────────────────────────────────────
const START_POSITIONS = [
  {x:CX,y:CY},{x:CX-600,y:CY-600},{x:CX+600,y:CY-600},
  {x:CX-600,y:CY+600},{x:CX+600,y:CY+600},{x:CX,y:CY-800},
  {x:CX,y:CY+800},{x:CX-800,y:CY},{x:CX+800,y:CY},{x:CX-400,y:CY+900},
];
function getStartPos(slot) { return START_POSITIONS[slot % START_POSITIONS.length]; }

function recalcOwnedCells() {
  let cnt=0;
  const mine=mySlot+1;
  for (let i=0;i<grid.length;i++) if(grid[i]===mine) cnt++;
  ownedCells=cnt;
}

// ─── Send input to server at 20 Hz ───────────────────────────
let inputTimer=0;
function sendInput(dt) {
  inputTimer += dt;
  if (inputTimer < 50) return;
  inputTimer = 0;
  if (!socket || !connected) return;

  let dx=0, dy=0;
  if (joy.active&&(joy.dx||joy.dy)) { dx=joy.dx; dy=joy.dy; }
  else if (input.active) {
    const wx=input.x+camera.x, wy=input.y+camera.y;
    const ddx=wx-player.x, ddy=wy-player.y;
    const d=Math.hypot(ddx,ddy);
    if(d>10){ dx=ddx/d; dy=ddy/d; }
  }
  socket.emit('input', { dx, dy });
}

// ─── Territory canvas ─────────────────────────────────────────
function redrawTerritoryCanvas() {
  tCtx.clearRect(0,0,W,H);
  for (let slot=0;slot<10;slot++){
    const gridVal=slot+1;
    const col=PLAYER_COLORS[slot];
    if(!col) continue;
    tCtx.fillStyle=col.fill+'45';
    for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++)
      if(grid[gi(c,r)]===gridVal) tCtx.fillRect(c*CELL,r*CELL,CELL,CELL);
    tCtx.strokeStyle=col.trail; tCtx.lineWidth=2; tCtx.beginPath();
    for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++){
      if(grid[gi(c,r)]!==gridVal) continue;
      const x=c*CELL, y=r*CELL;
      if(getG(c,r-1)!==gridVal){tCtx.moveTo(x,y);      tCtx.lineTo(x+CELL,y);}
      if(getG(c,r+1)!==gridVal){tCtx.moveTo(x,y+CELL); tCtx.lineTo(x+CELL,y+CELL);}
      if(getG(c-1,r)!==gridVal){tCtx.moveTo(x,y);      tCtx.lineTo(x,y+CELL);}
      if(getG(c+1,r)!==gridVal){tCtx.moveTo(x+CELL,y); tCtx.lineTo(x+CELL,y+CELL);}
    }
    tCtx.stroke();
  }
}

// ─── Hex helper ───────────────────────────────────────────────
function hexPath(ctx2d,hx,hy,r,rotation){
  ctx2d.beginPath();
  for(let i=0;i<6;i++){
    const a=rotation+(Math.PI/3)*i;
    const px=hx+Math.cos(a)*r, py=hy+Math.sin(a)*r;
    if(i===0)ctx2d.moveTo(px,py);else ctx2d.lineTo(px,py);
  }
  ctx2d.closePath();
}

// ─── Minimap ──────────────────────────────────────────────────
function rebuildMinimap(){
  mmCtx.clearRect(0,0,mmSize,mmSize);
  mmCtx.fillStyle='#0a0c14'; mmCtx.fillRect(0,0,mmSize,mmSize);
  const sx=mmSize/COLS, sy=mmSize/ROWS;
  for(let slot=0;slot<10;slot++){
    const gridVal=slot+1, col=PLAYER_COLORS[slot];
    if(!col) continue;
    mmCtx.fillStyle=col.fill+'99';
    for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++)
      if(grid[gi(c,r)]===gridVal) mmCtx.fillRect(c*sx,r*sy,sx+0.5,sy+0.5);
  }
  mmDirty=false;
}

function renderMinimap(vw,vh,cx,cy){
  if(mmDirty) rebuildMinimap();
  const R=70, mx=vw-R-16, my=vh-R-16;
  ctx.save();
  ctx.beginPath(); ctx.arc(mx,my,R,0,Math.PI*2); ctx.clip();
  ctx.drawImage(mmCanvas,mx-R,my-R,R*2,R*2);

  for(const rp of [...remotePlayers.values(),{...player,id:myId,slot:mySlot,trail:player.trail,outside:player.outside}]){
    if(!rp.outside||!rp.trail||rp.trail.length<2) continue;
    const col=PLAYER_COLORS[rp.slot]; if(!col) continue;
    const scx=(R*2)/W, scy=(R*2)/H;
    ctx.strokeStyle=col.trail; ctx.lineWidth=1; ctx.globalAlpha=0.8;
    ctx.beginPath();
    for(let i=0;i<rp.trail.length;i++){
      const tx=mx-R+rp.trail[i].x*scx, ty=my-R+rp.trail[i].y*scy;
      if(i===0)ctx.moveTo(tx,ty);else ctx.lineTo(tx,ty);
    }
    ctx.stroke(); ctx.globalAlpha=1;
  }

  ctx.strokeStyle='rgba(255,255,255,0.2)'; ctx.lineWidth=1;
  ctx.strokeRect(mx-R+cx*(R*2/W),my-R+cy*(R*2/H),vw*(R*2/W),vh*(R*2/H));

  for(const rp of remotePlayers.values()){
    const col=PLAYER_COLORS[rp.slot]; if(!col) continue;
    ctx.fillStyle=col.fill;
    ctx.beginPath(); ctx.arc(mx-R+rp.x*(R*2/W),my-R+rp.y*(R*2/H),2.5,0,Math.PI*2); ctx.fill();
  }
  ctx.fillStyle='#fff';
  ctx.beginPath(); ctx.arc(mx-R+player.x*(R*2/W),my-R+player.y*(R*2/H),2.5,0,Math.PI*2); ctx.fill();

  if(powerup.active&&powerup.type){
    const _def=POWERUP_TYPES[powerup.type];
    const pulse=0.6+0.4*Math.sin(globalTime*0.006);
    ctx.fillStyle=_def.color; ctx.globalAlpha=pulse;
    ctx.shadowColor=_def.glowColor; ctx.shadowBlur=4;
    ctx.beginPath(); ctx.arc(mx-R+powerup.x*(R*2/W),my-R+powerup.y*(R*2/H),2,0,Math.PI*2); ctx.fill();
    ctx.shadowBlur=0; ctx.globalAlpha=1;
  }
  ctx.restore();
  ctx.save(); ctx.strokeStyle='rgba(0,200,255,0.4)'; ctx.lineWidth=1.5;
  ctx.beginPath(); ctx.arc(mx,my,R,0,Math.PI*2); ctx.stroke(); ctx.restore();
}

// ─── Init ─────────────────────────────────────────────────────
function init(){
  injectStyles();
  injectUIElements();
  // Assign DOM refs after injection
  elKillfeed    = document.getElementById('killfeed');
  elLeaderboard = document.getElementById('leaderboard-list');
  elConnStatus  = document.getElementById('conn-status');
  elPlayerCount = document.getElementById('player-count');

  redrawTerritoryCanvas();
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // PC mouse
  canvas.addEventListener('mousemove', e=>{
    input.x=e.clientX; input.y=e.clientY; input.active=true;
    cursor.x=e.clientX; cursor.y=e.clientY;
  });

  // Mobile touch joystick
  canvas.addEventListener('touchstart', e=>{ e.preventDefault();
    const t=e.changedTouches[0];
    joy.active=true; joy.startX=t.clientX; joy.startY=t.clientY; joy.dx=0; joy.dy=0;
  },{ passive:false });
  canvas.addEventListener('touchmove', e=>{ e.preventDefault();
    const t=e.changedTouches[0];
    const dx=t.clientX-joy.startX, dy=t.clientY-joy.startY;
    const d=Math.hypot(dx,dy);
    if(d>8){ joy.dx=dx/d; joy.dy=dy/d; }
  },{ passive:false });
  canvas.addEventListener('touchend', ()=>{ joy.active=false; joy.dx=0; joy.dy=0; });

  setTimeout(()=>elHint&&elHint.classList.add('hidden'), 5000);

  // FIX: connectSocket is the entry point; name prompt fires after 'init' event from server
  connectSocket();
}

function resizeCanvas(){ canvas.width=window.innerWidth; canvas.height=window.innerHeight; }

// ─── Capture FX ───────────────────────────────────────────────
function spawnCaptureFX(cells){
  if(cells>0) pulses.push({x:player.x,y:player.y,r:0,maxR:Math.sqrt(cells)*CELL*0.8,age:0,dur:600});
  flashAlpha.v=cells>0?0.35:0.6;
  if(elScore&&cells>0){
    elScore.classList.remove('score-pop');
    void elScore.offsetWidth;
    elScore.classList.add('score-pop');
  }
}

// ─── Update — Strong Client-Side Prediction ─────────────────────
function update(dt){
  const _eff         = effect.type ? POWERUP_TYPES[effect.type] : null;
  const currentSpeed = _eff ? SPEED * _eff.speedMult : SPEED;
  const currentSteer = _eff ? 0.15 * _eff.steerMult : 0.15;

  // === LOCAL PREDICTION (instant feel) ===
  let moved = false;
  if(joy.active && (joy.dx || joy.dy)){
    const target = Math.atan2(joy.dy, joy.dx);
    player.angle = lerpAngle(player.angle, target, currentSteer);
    moved = true;
  } else if(input.active){
    const wx = input.x + camera.x, wy = input.y + camera.y;
    const ddx = wx - player.x, ddy = wy - player.y;
    if(Math.hypot(ddx, ddy) > 10){
      const target = Math.atan2(ddy, ddx);
      player.angle = lerpAngle(player.angle, target, currentSteer);
      moved = true;
    }
  }

  if(moved){
    player.x += Math.cos(player.angle) * currentSpeed;
    player.y += Math.sin(player.angle) * currentSpeed;

    // Clamp to world
    const dist = Math.hypot(player.x - CX, player.y - CY);
    if(dist > RADIUS){
      const nx = (player.x - CX) / dist;
      const ny = (player.y - CY) / dist;
      player.x = CX + nx * RADIUS;
      player.y = CY + ny * RADIUS;
    }
  }

  // Local trail for smooth rendering
  const [pc, pr] = worldToCell(player.x, player.y);
  const onOwn = getG(pc, pr) === (mySlot + 1);
  const _trailDist = _eff ? TRAIL_DIST * _eff.trailDistMult : TRAIL_DIST;

  if(!player.outside){
    if(!onOwn){
      player.outside = true;
      player.trail = [{x: player.x, y: player.y}];
    }
  } else {
    const last = player.trail[player.trail.length-1];
    if(Math.hypot(player.x - last.x, player.y - last.y) >= _trailDist){
      player.trail.push({x: player.x, y: player.y});
    }
    if(onOwn){
      // Optimistic clear — server will confirm
      player.outside = false;
      player.trail = [];
    }
  }

  // Cosmetic timers
  if(effect.type && effect.remaining !== Infinity){
    effect.remaining -= dt;
    if(effect.remaining <= 0){ effect.type = null; effect.remaining = 0; }
  }
  if(powerup.active) powerup.despawnTimer -= dt;

  // Camera follow
  const tx = player.x - canvas.width/2;
  const ty = player.y - canvas.height/2;
  camera.x += (tx - camera.x) * 0.12;
  camera.y += (ty - camera.y) * 0.12;

  // FX + FPS
  globalTime += dt;
  for(let i = pulses.length-1; i >= 0; i--){
    pulses[i].age += dt;
    if(pulses[i].age > pulses[i].dur) pulses.splice(i,1);
  }
  flashAlpha.v *= 0.88;

  fpsFrames++; fpsAccum += dt;
  if(fpsAccum >= 1000){ fps = fpsFrames; fpsFrames = 0; fpsAccum -= 1000; }

  sendInput(dt);
}
function lerpAngle(cur,tgt,t){
  let d=tgt-cur;
  while(d> Math.PI)d-=Math.PI*2;
  while(d<-Math.PI)d+=Math.PI*2;
  return cur+d*t;
}

// ─── Render ───────────────────────────────────────────────────
function render(){
  const vw=canvas.width, vh=canvas.height;
  const cx=Math.round(camera.x), cy=Math.round(camera.y);

  ctx.clearRect(0,0,vw,vh);
  ctx.fillStyle=C_BG; ctx.fillRect(0,0,vw,vh);

  // World circle
  ctx.save();
  ctx.beginPath(); ctx.arc(CX-cx,CY-cy,RADIUS,0,Math.PI*2);
  ctx.fillStyle='rgba(0,180,255,0.04)'; ctx.fill();
  ctx.strokeStyle='rgba(0,180,255,0.12)'; ctx.lineWidth=2; ctx.stroke();
  ctx.restore();

  // Grid lines
  ctx.save(); ctx.strokeStyle=C_GRID; ctx.lineWidth=1;
  const gc0=Math.max(0,Math.floor(cx/CELL)), gc1=Math.min(COLS,Math.ceil((cx+vw)/CELL));
  const gr0=Math.max(0,Math.floor(cy/CELL)), gr1=Math.min(ROWS,Math.ceil((cy+vh)/CELL));
  ctx.beginPath();
  for(let c=gc0;c<=gc1;c++){const sx=c*CELL-cx;ctx.moveTo(sx,0);ctx.lineTo(sx,vh);}
  for(let r=gr0;r<=gr1;r++){const sy=r*CELL-cy;ctx.moveTo(0,sy);ctx.lineTo(vw,sy);}
  ctx.stroke(); ctx.restore();

  // Territory blit
  ctx.drawImage(tCanvas,cx,cy,vw,vh,0,0,vw,vh);

  // Remote players
  for(const rp of remotePlayers.values()){
    const col=PLAYER_COLORS[rp.slot]||PLAYER_COLORS[0];
    const rpx=rp.x-cx, rpy=rp.y-cy;

    if(rp.outside&&rp.trail&&rp.trail.length>=2){
      ctx.save(); ctx.lineJoin='round'; ctx.lineCap='round';
      const isPhantom=rp.effectType==='phantom';
      ctx.strokeStyle=isPhantom?col.trail+'40':col.trail+'50'; ctx.lineWidth=8;
      ctx.beginPath(); ctx.moveTo(rp.trail[0].x-cx,rp.trail[0].y-cy);
      for(let i=1;i<rp.trail.length;i++) ctx.lineTo(rp.trail[i].x-cx,rp.trail[i].y-cy);
      ctx.stroke();
      ctx.strokeStyle=isPhantom?col.trail+'60':col.trail; ctx.lineWidth=3;
      ctx.beginPath(); ctx.moveTo(rp.trail[0].x-cx,rp.trail[0].y-cy);
      for(let i=1;i<rp.trail.length;i++) ctx.lineTo(rp.trail[i].x-cx,rp.trail[i].y-cy);
      ctx.stroke(); ctx.restore();
    }

    const grd2=ctx.createRadialGradient(rpx,rpy,0,rpx,rpy,20);
    grd2.addColorStop(0,col.glow+'80'); grd2.addColorStop(1,col.glow+'00');
    ctx.fillStyle=grd2; ctx.beginPath(); ctx.arc(rpx,rpy,20,0,Math.PI*2); ctx.fill();
    ctx.fillStyle=col.fill; ctx.beginPath(); ctx.arc(rpx,rpy,9,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#fff';  ctx.beginPath(); ctx.arc(rpx,rpy,4,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='rgba(255,255,255,0.8)';
    ctx.beginPath(); ctx.arc(rpx+Math.cos(rp.angle)*11,rpy+Math.sin(rp.angle)*11,2.5,0,Math.PI*2); ctx.fill();
    ctx.save();
    ctx.font='bold 11px Segoe UI,system-ui,sans-serif';
    ctx.textAlign='center'; ctx.textBaseline='bottom';
    ctx.fillStyle=col.trail; ctx.shadowColor='#000'; ctx.shadowBlur=4;
    ctx.fillText(rp.name||'?',rpx,rpy-13); ctx.restore();
  }

  // Local player trail
  const myCol=PLAYER_COLORS[mySlot]||PLAYER_COLORS[0];
  if(player.outside&&player.trail.length>=2){
    ctx.save(); ctx.lineJoin='round'; ctx.lineCap='round';
    const isPhantom=effect.type==='phantom';
    const isOvercharge=effect.type==='overcharge';
    ctx.strokeStyle=isPhantom?'rgba(206,147,216,0.22)':isOvercharge?'rgba(255,215,0,0.45)':myCol.trail+'50';
    ctx.lineWidth=isOvercharge?18:10;
    ctx.shadowColor=isOvercharge?'#ffaa00':'transparent'; ctx.shadowBlur=isOvercharge?20:0;
    ctx.beginPath(); ctx.moveTo(player.trail[0].x-cx,player.trail[0].y-cy);
    for(let i=1;i<player.trail.length;i++) ctx.lineTo(player.trail[i].x-cx,player.trail[i].y-cy);
    ctx.stroke(); ctx.shadowBlur=0;
    ctx.strokeStyle=isPhantom?'#ce93d8':isOvercharge?'#ffd700':myCol.trail;
    ctx.lineWidth=isOvercharge?4.5:3;
    ctx.beginPath(); ctx.moveTo(player.trail[0].x-cx,player.trail[0].y-cy);
    for(let i=1;i<player.trail.length;i++) ctx.lineTo(player.trail[i].x-cx,player.trail[i].y-cy);
    ctx.stroke(); ctx.restore();
  }

  // Capture pulses
  for(const p of pulses){
    const t=p.age/p.dur, alpha=(1-t)*(1-t)*0.7, r=p.maxR*Math.pow(t,0.5);
    ctx.save(); ctx.beginPath(); ctx.arc(p.x-cx,p.y-cy,r,0,Math.PI*2);
    ctx.strokeStyle=`rgba(0,220,255,${alpha})`; ctx.lineWidth=3+(1-t)*6; ctx.stroke(); ctx.restore();
  }

  // Powerup
  if(powerup.active&&powerup.type){
    const def=POWERUP_TYPES[powerup.type];
    const t=globalTime*0.001, rot=t*0.9, brt=0.55+0.45*Math.sin(t*3.5);
    const hx=powerup.x-cx, hy=powerup.y-cy;
    const despawnFrac=powerup.despawnTimer/POWERUP_DESPAWN;
    const isDying=despawnFrac<0.25;
    const flashOn=!isDying||(Math.sin(globalTime*0.025)>0);
    const baseAlpha=isDying?(0.35+0.65*(despawnFrac/0.25)):1;
    if(flashOn){
      ctx.save(); ctx.globalAlpha=baseAlpha;
      const glow=ctx.createRadialGradient(hx,hy,0,hx,hy,POWERUP_HEX_SIZE*2.8);
      glow.addColorStop(0,def.glowColor+'55'); glow.addColorStop(1,def.glowColor+'00');
      ctx.fillStyle=glow; ctx.beginPath(); ctx.arc(hx,hy,POWERUP_HEX_SIZE*2.8,0,Math.PI*2); ctx.fill();
      hexPath(ctx,hx,hy,POWERUP_HEX_SIZE,rot);
      ctx.fillStyle=def.color+'30'; ctx.fill();
      ctx.shadowColor=def.glowColor; ctx.shadowBlur=14*brt;
      ctx.strokeStyle=def.color+`${Math.round(0xcc*brt).toString(16).padStart(2,'0')}`; ctx.lineWidth=2.5; ctx.stroke();
      ctx.shadowBlur=0;
      hexPath(ctx,hx,hy,POWERUP_HEX_SIZE*0.52,rot+Math.PI/6);
      ctx.strokeStyle=def.color+'99'; ctx.lineWidth=1.5; ctx.stroke();
      ctx.fillStyle=def.color; ctx.globalAlpha=baseAlpha*(0.85+0.15*brt);
      ctx.font='bold 13px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText(def.icon,hx,hy);
      if(isDying){
        ctx.globalAlpha=baseAlpha*0.9; ctx.strokeStyle=def.color; ctx.lineWidth=2.5;
        ctx.shadowColor=def.glowColor; ctx.shadowBlur=8;
        ctx.beginPath(); ctx.arc(hx,hy,POWERUP_HEX_SIZE+8,-Math.PI/2,-Math.PI/2+Math.PI*2*(despawnFrac/0.25));
        ctx.stroke(); ctx.shadowBlur=0;
      }
      ctx.restore();
    }
  }

  // Local player with effect ring
  if(effect.type){
    const def=POWERUP_TYPES[effect.type];
    const frac=effect.remaining===Infinity?1:Math.max(0,effect.remaining/def.duration);
    const pulse=0.55+0.3*Math.sin(globalTime*0.012);
    const px2=player.x-cx, py2=player.y-cy;
    ctx.save();
    if(def.bigGlow){
      const shieldGlow=ctx.createRadialGradient(px2,py2,10,px2,py2,55);
      shieldGlow.addColorStop(0,def.glowColor+'40'); shieldGlow.addColorStop(1,def.glowColor+'00');
      ctx.fillStyle=shieldGlow; ctx.beginPath(); ctx.arc(px2,py2,55,0,Math.PI*2); ctx.fill();
      ctx.shadowColor=def.glowColor; ctx.shadowBlur=18*pulse;
      hexPath(ctx,px2,py2,22,globalTime*0.0008);
      ctx.strokeStyle=def.color+Math.round(0.5*255*pulse).toString(16).padStart(2,'0');
      ctx.lineWidth=2; ctx.stroke(); ctx.shadowBlur=0;
      ctx.strokeStyle=def.color+'cc'; ctx.lineWidth=2.5;
      ctx.shadowColor=def.glowColor; ctx.shadowBlur=12;
      ctx.beginPath(); ctx.arc(px2,py2,15,0,Math.PI*2); ctx.stroke(); ctx.shadowBlur=0;
    } else {
      ctx.strokeStyle=def.color+Math.round((0.55+0.3*pulse)*255).toString(16).padStart(2,'0');
      ctx.lineWidth=2.5; ctx.shadowColor=def.glowColor; ctx.shadowBlur=10;
      ctx.beginPath(); ctx.arc(px2,py2,15,-Math.PI/2,-Math.PI/2+Math.PI*2*frac); ctx.stroke();
      ctx.shadowBlur=0;
    }
    ctx.restore();
  }

  const px=player.x-cx, py=player.y-cy;
  const grd=ctx.createRadialGradient(px,py,0,px,py,20);
  grd.addColorStop(0,myCol.glow+'80'); grd.addColorStop(1,myCol.glow+'00');
  ctx.fillStyle=grd; ctx.beginPath(); ctx.arc(px,py,20,0,Math.PI*2); ctx.fill();
  ctx.fillStyle=myCol.fill; ctx.beginPath(); ctx.arc(px,py,9,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='#fff';     ctx.beginPath(); ctx.arc(px,py,4,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='rgba(255,255,255,0.8)';
  ctx.beginPath(); ctx.arc(px+Math.cos(player.angle)*11,py+Math.sin(player.angle)*11,2.5,0,Math.PI*2); ctx.fill();

  // Flash overlay
  if(flashAlpha.v>0.005){
    const _fc=effect.type?POWERUP_TYPES[effect.type].glowColor:'#00e5ff';
    ctx.fillStyle=_fc+Math.round(flashAlpha.v*0.28*255).toString(16).padStart(2,'0');
    ctx.fillRect(0,0,vw,vh);
  }

  // Powerup edge chevron
  if(powerup.active){
    const adx=powerup.x-player.x, ady=powerup.y-player.y;
    const onScreen=(powerup.x-cx>40&&powerup.x-cx<vw-40&&powerup.y-cy>40&&powerup.y-cy<vh-40);
    if(!onScreen){
      const aAngle=Math.atan2(ady,adx);
      const pulse=0.65+0.35*Math.sin(globalTime*0.007);
      const margin=38;
      const farX=vw/2+Math.cos(aAngle)*9999, farY=vh/2+Math.sin(aAngle)*9999;
      const scaleX=farX<margin?(margin-vw/2)/(farX-vw/2):farX>vw-margin?(vw-margin-vw/2)/(farX-vw/2):1;
      const scaleY=farY<margin?(margin-vh/2)/(farY-vh/2):farY>vh-margin?(vh-margin-vh/2)/(farY-vh/2):1;
      const sc=Math.min(scaleX,scaleY);
      const chevX=vw/2+(farX-vw/2)*sc, chevY=vh/2+(farY-vh/2)*sc;
      const _def2=powerup.type?POWERUP_TYPES[powerup.type]:POWERUP_TYPES.overcharge;
      ctx.save(); ctx.translate(chevX,chevY); ctx.rotate(aAngle);
      ctx.shadowColor=_def2.glowColor; ctx.shadowBlur=10*pulse;
      ctx.strokeStyle=_def2.color+Math.round(pulse*255).toString(16).padStart(2,'0');
      ctx.lineWidth=3; ctx.lineCap='round'; ctx.lineJoin='round';
      ctx.beginPath(); ctx.moveTo(-9,-9); ctx.lineTo(0,0); ctx.lineTo(-9,9); ctx.stroke();
      ctx.shadowBlur=0; ctx.restore();
    }
  }

  // Custom cursor
  if(cursor.x>0){
    const mx=cursor.x, my=cursor.y, cr=6, cl=10;
    ctx.save();
    ctx.strokeStyle='rgba(255,255,255,0.9)'; ctx.lineWidth=1.5;
    ctx.shadowColor='rgba(0,229,255,0.6)'; ctx.shadowBlur=6;
    ctx.beginPath(); ctx.arc(mx,my,cr,0,Math.PI*2); ctx.stroke();
    const gap=3;
    ctx.beginPath();
    ctx.moveTo(mx,my-cr-gap); ctx.lineTo(mx,my-cr-gap-cl);
    ctx.moveTo(mx,my+cr+gap); ctx.lineTo(mx,my+cr+gap+cl);
    ctx.moveTo(mx-cr-gap,my); ctx.lineTo(mx-cr-gap-cl,my);
    ctx.moveTo(mx+cr+gap,my); ctx.lineTo(mx+cr+gap+cl,my);
    ctx.stroke(); ctx.shadowBlur=0;
    ctx.fillStyle='rgba(255,255,255,0.95)'; ctx.beginPath(); ctx.arc(mx,my,1.5,0,Math.PI*2); ctx.fill();
    ctx.restore();
  }

  if(joy.active){
    const jx=joy.startX, jy=joy.startY, maxR=50;
    ctx.save(); ctx.globalAlpha=0.35;
    ctx.strokeStyle='#fff'; ctx.lineWidth=1.5;
    ctx.beginPath(); ctx.arc(jx,jy,maxR,0,Math.PI*2); ctx.stroke();
    ctx.fillStyle='rgba(0,229,255,0.6)';
    ctx.beginPath(); ctx.arc(jx+joy.dx*maxR,jy+joy.dy*maxR,16,0,Math.PI*2); ctx.fill();
    ctx.restore();
  }

  renderMinimap(vw,vh,cx,cy);
  renderKillFeed();
  renderHUD();
}

// ─── Kill feed DOM ────────────────────────────────────────────
function renderKillFeed(){
  if(!elKillfeed) return;
  const now=Date.now();
  while(killFeed.length&&now-killFeed[killFeed.length-1].ts>KILLFEED_DURATION) killFeed.pop();
  elKillfeed.innerHTML='';
  for(let i=0;i<Math.min(killFeed.length,5);i++){
    const kf=killFeed[i];
    const age=(now-kf.ts)/KILLFEED_DURATION;
    const div=document.createElement('div');
    div.className='kf-entry';
    div.style.opacity=Math.max(0,1-age*1.5);
    div.style.color=kf.color;
    div.textContent=kf.text;
    elKillfeed.appendChild(div);
  }
}

function renderLeaderboardDOM(){
  if(!elLeaderboard) return;
  elLeaderboard.innerHTML='';
  leaderboard.slice(0,10).forEach((entry,i)=>{
    const col=PLAYER_COLORS[entry.slot]||PLAYER_COLORS[0];
    const row=document.createElement('div');
    row.className='lb-row'+(entry.id===myId?' lb-me':'');
    row.innerHTML=`<span class="lb-rank">${i+1}</span>
      <span class="lb-dot" style="background:${col.fill}"></span>
      <span class="lb-name">${escapeHtml(entry.name||'?')}</span>
      <span class="lb-score">${entry.score.toLocaleString()}</span>`;
    elLeaderboard.appendChild(row);
  });
}

function escapeHtml(s){
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function renderHUD(){
  const pct=Math.min(100,(ownedCells/totalOwnableCells*100)).toFixed(1);
  if(elScore) elScore.textContent=territoryScore.toLocaleString();
  if(elPct)   elPct.textContent=pct+'% of map';
  if(elFps)   elFps.textContent=fps;
  if(elPos)   elPos.textContent=`${Math.round(player.x)} / ${Math.round(player.y)}`;
  if(elTrail) elTrail.textContent=player.trail.length;
  if(elOwned) elOwned.textContent=ownedCells;
  if(elState) elState.textContent=player.outside?'TRAIL':'HOME';

  const elBoost=document.getElementById('d-boost');
  if(elBoost){
    if(effect.type){
      const _def=POWERUP_TYPES[effect.type];
      const _rem=effect.remaining===Infinity?'∞':(effect.remaining/1000).toFixed(1)+'s';
      elBoost.textContent=_def.label+' '+_rem; elBoost.style.color=_def.color;
    } else { elBoost.textContent='—'; elBoost.style.color=''; }
  }
  if(elBoostHud){
    elBoostHud.style.display=effect.type?'block':'none';
    if(effect.type){
      const _def=POWERUP_TYPES[effect.type];
      const _rarityDot=_def.rarity==='Epic'?'🟣':'🔵';
      elBoostHud.querySelector('.hud-label').textContent=_def.icon+' '+_def.label+'  '+_rarityDot+' '+_def.rarity;
      elBoostHud.querySelector('.hud-label').style.color=_def.color;
      elBoostHud.style.borderColor=_def.color+'55';
    }
  }
  if(elBoostTimer&&effect.type){
    elBoostTimer.style.color=POWERUP_TYPES[effect.type].color;
    elBoostTimer.textContent=effect.remaining===Infinity?'∞':(effect.remaining/1000).toFixed(1)+'s';
  }
}

// ─── Inject UI elements ───────────────────────────────────────
function injectUIElements(){
  const lb=document.createElement('div');
  lb.id='leaderboard';
  lb.innerHTML=`
    <div class="lb-header">
      <span class="lb-title">🏆 Leaderboard</span>
      <span id="player-count" class="lb-pcount">0/10</span>
    </div>
    <div id="leaderboard-list"></div>
    <div class="lb-status">
      <span id="conn-status" style="color:#ff5252">Connecting…</span>
    </div>`;
  document.body.appendChild(lb);

  const kf=document.createElement('div');
  kf.id='killfeed';
  document.body.appendChild(kf);
}

function injectStyles(){
  const s=document.createElement('style');
  s.textContent=`
    @keyframes scorePop{0%{transform:scale(1);color:#fff}35%{transform:scale(1.25);color:#00e5ff}100%{transform:scale(1);color:#fff}}
    .score-pop{animation:scorePop 0.45s cubic-bezier(.22,1,.36,1) forwards}
    #leaderboard{position:fixed;top:16px;right:16px;z-index:10;background:rgba(7,9,20,0.82);border:1px solid rgba(0,200,255,0.15);border-radius:12px;padding:10px 14px;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);min-width:200px;pointer-events:none;}
    .lb-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;}
    .lb-title{font-size:9px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:rgba(0,200,255,.55);}
    .lb-pcount{font-size:9px;color:rgba(255,255,255,.3);font-weight:600;}
    .lb-row{display:flex;align-items:center;gap:6px;padding:3px 0;font-size:11px;color:rgba(255,255,255,.7);}
    .lb-me{color:#fff;font-weight:700;}
    .lb-rank{width:14px;text-align:right;color:rgba(255,255,255,.3);font-size:10px;}
    .lb-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;}
    .lb-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .lb-score{font-variant-numeric:tabular-nums;color:rgba(255,255,255,.45);font-size:10px;}
    .lb-status{margin-top:6px;padding-top:5px;border-top:1px solid rgba(255,255,255,.06);font-size:9px;text-align:center;}
    #killfeed{position:fixed;bottom:60px;right:16px;z-index:10;display:flex;flex-direction:column;gap:4px;align-items:flex-end;pointer-events:none;min-width:220px;}
    .kf-entry{background:rgba(7,9,20,0.75);border:1px solid rgba(255,255,255,0.07);border-radius:6px;padding:5px 10px;font-size:11px;font-weight:600;letter-spacing:.02em;backdrop-filter:blur(6px);transition:opacity .3s;white-space:nowrap;}
  `;
  document.head.appendChild(s);
}

// ─── Game loop ────────────────────────────────────────────────
function loop(ts){
  const dt=Math.min(ts-lastTime,50);
  lastTime=ts;
  update(dt);
  render();
  requestAnimationFrame(loop);
}

init();
requestAnimationFrame(loop);
