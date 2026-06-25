/* =============================================================
   TERRITORY.IO — Multiplayer Client (IMPROVED)
   ============================================================= */

// ▼▼▼ CHANGE THIS to your Render server URL ▼▼▼
const SERVER_URL = 'https://cyber-claim.onrender.com';
const LOCAL_AUTHORITY = true;   // Keep true for better feel on free tier

// ─── Constants (must match server) ───────────────────────────
const CELL = 20;
const COLS = 200;
const ROWS = 200;
const W = COLS * CELL;
const H = ROWS * CELL;
const CX = W / 2;
const CY = H / 2;
const RADIUS = Math.min(W, H) / 2 - CELL;

const SPEED = 2.6;
const TRAIL_DIST = 6;
const START_HALF = 5;

const POWERUP_PICKUP_R = 20;
const POWERUP_HEX_SIZE = 18;
const POWERUP_RESPAWN = 22000;
const POWERUP_DESPAWN = 12000;

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

const C_BG = '#07090f';
const C_GRID = 'rgba(255,255,255,0.025)';

// ─── Canvas / context ─────────────────────────────────────────
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

const tCanvas = document.createElement('canvas');
tCanvas.width = W; tCanvas.height = H;
const tCtx = tCanvas.getContext('2d');

const mmSize = 160;
const mmCanvas = document.createElement('canvas');
mmCanvas.width = mmSize; mmCanvas.height = mmSize;
const mmCtx = mmCanvas.getContext('2d');
let mmDirty = true;

// ─── Shared grid ──────────────────────────────────────────────
const grid = new Uint8Array(COLS * ROWS);
function gi(c,r) { return r*COLS+c; }
function inBounds(c,r) { return c>=0&&c<COLS&&r>=0&&r<ROWS; }
function getG(c,r) { return inBounds(c,r)?grid[gi(c,r)]:0; }
function worldToCell(x,y) { return [Math.floor(x/CELL), Math.floor(y/CELL)]; }

// ─── Multiplayer state ────────────────────────────────────────
let socket = null;
let myId = null;
let mySlot = 0;
let connected = false;

const remotePlayers = new Map();

const player = {
  x:CX, y:CY, angle:0,
  trail:[], outside:false,
  slot:0,
};

// ─── Kill feed / Leaderboard ──────────────────────────────────
const killFeed = [];
const KILLFEED_DURATION = 5000;
function addKillFeed(text, color='#fff') {
  killFeed.unshift({ text, color, ts:Date.now() });
  if (killFeed.length > 6) killFeed.pop();
}

let leaderboard = [];
let ownedCells = 0;
let territoryScore = 0;
let totalOwnableCells = 0;
for (let r=0;r<ROWS;r++) for (let c=0;c<COLS;c++) {
  const wx=(c+0.5)*CELL, wy=(r+0.5)*CELL;
  if(Math.hypot(wx-CX,wy-CY)<=RADIUS) totalOwnableCells++;
}

// ─── Powerup ──────────────────────────────────────────────────
const powerup = { x:0, y:0, active:false, type:null, despawnTimer:POWERUP_DESPAWN };
const effect = { type:null, remaining:0 };

// ─── Input / Camera ───────────────────────────────────────────
const camera = { x:0, y:0 };
const input = { x:0, y:0, active:false };
const cursor = { x:-999, y:-999 };
const joy = { active:false, startX:0, startY:0, dx:0, dy:0 };

// ─── FX ───────────────────────────────────────────────────────
let globalTime=0, lastTime=0, fps=0, fpsAccum=0, fpsFrames=0;
const pulses = [];
const flashAlpha = { v:0 };

// ─── DOM ──────────────────────────────────────────────────────
const elScore = document.getElementById('score-display');
const elPct = document.getElementById('pct-display');
const elFps = document.getElementById('d-fps');
const elPos = document.getElementById('d-pos');
const elTrail = document.getElementById('d-trail');
const elOwned = document.getElementById('d-owned');
const elState = document.getElementById('d-state');
const elHint = document.getElementById('hint');
const elBoostHud = document.getElementById('boost-hud');
const elBoostTimer = document.getElementById('boost-timer');
const elFlash = document.getElementById('capture-flash');

let elKillfeed = null;
let elLeaderboard = null;
let elConnStatus = null;
let elPlayerCount = null;

// ─── Socket ───────────────────────────────────────────────────
function connectSocket() {
  const script = document.createElement('script');
  script.src = SERVER_URL + '/socket.io/socket.io.js';
  script.onload = () => initSocket();
  script.onerror = () => {
    if (elConnStatus) { elConnStatus.textContent='Server unreachable'; elConnStatus.style.color='#ff5252'; }
  };
  document.head.appendChild(script);
}

function initSocket() {
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
    myId = data.myId;
    mySlot = data.mySlot;
    if (data.colors) PLAYER_COLORS = data.colors;

    const buf = Uint8Array.from(atob(data.grid), c=>c.charCodeAt(0));
    grid.set(buf);
    redrawTerritoryCanvas();
    mmDirty = true;

    player.slot = mySlot;
    player.outside = false;
    player.trail = [];
    const myStart = data.players.find(p=>p.id===myId);
    if (myStart) { player.x=myStart.x; player.y=myStart.y; player.angle=myStart.angle; }

    remotePlayers.clear();
    for (const rp of data.players) {
      if (rp.id !== myId) remotePlayers.set(rp.id, {...rp, targetX:rp.x, targetY:rp.y, targetAngle:rp.angle});
    }

    if (data.powerup) Object.assign(powerup, data.powerup);
    recalcOwnedCells();
    if (elPlayerCount) elPlayerCount.textContent = data.players.length + '/10';
    promptName();
  });

  socket.on('playerJoined', data => {
    if (data.id !== myId) remotePlayers.set(data.id, {...data, targetX:data.x, targetY:data.y, targetAngle:data.angle});
    addKillFeed(`${data.name} joined`, '#aaa');
    if (elPlayerCount) elPlayerCount.textContent = (remotePlayers.size+1) + '/10';
  });

  socket.on('playerLeft', data => {
    remotePlayers.delete(data.id);
    if (elPlayerCount) elPlayerCount.textContent = (remotePlayers.size+1) + '/10';
  });

  socket.on('playerPositions', list => {
    for (const rp of list) {
      if (rp.id === myId) {
        player.x = player.x * 0.72 + rp.x * 0.28;
        player.y = player.y * 0.72 + rp.y * 0.28;
        player.angle = lerpAngle(player.angle, rp.angle, 0.35);
        player.outside = rp.outside;
        if (!rp.outside) player.trail = [];
      } else {
        const remote = remotePlayers.get(rp.id);
        if (remote) {
          remote.targetX = rp.x;
          remote.targetY = rp.y;
          remote.targetAngle = rp.angle;
          remote.outside = rp.outside;
          remote.trail = rp.trail || [];
          remote.effectType = rp.effectType;
        } else {
          remotePlayers.set(rp.id, {...rp, targetX:rp.x, targetY:rp.y, targetAngle:rp.angle});
        }
      }
    }
  });

  let lastRedraw = 0;
  socket.on('gridUpdate', b64 => {
    const now = Date.now();
    if (now - lastRedraw < 80) return;
    lastRedraw = now;
    const buf = Uint8Array.from(atob(b64), c=>c.charCodeAt(0));
    grid.set(buf);
    redrawTerritoryCanvas();
    mmDirty = true;
    recalcOwnedCells();
  });

  socket.on('leaderboard', data => {
    leaderboard = data;
    const mine = leaderboard.find(e=>e.id===myId);
    if (mine) territoryScore = mine.score;
    renderLeaderboardDOM();
  });

  socket.on('playerKilled', data => {
    const { victimName, killerName, killerSlot, victimId, reason } = data;
    const kColor = killerSlot !== undefined ? (PLAYER_COLORS[killerSlot]?.trail||'#fff') : '#fff';
    let msg = reason==='self' ? `${victimName} cut their own trail` :
              reason==='trail_cut' ? `${killerName} cut ${victimName}'s trail` : `${victimName} was eliminated`;
    addKillFeed(msg, kColor);

    if (victimId === myId) {
      player.outside = false;
      player.trail = [];
      const sp = getStartPos(mySlot);
      player.x = sp.x; player.y = sp.y; player.angle = 0;
      flashAlpha.v = 0.9;
    }
  });

  socket.on('powerupState', data => Object.assign(powerup, data));
  socket.on('powerupPickup', data => {
    if (data.playerId === myId) {
      const def = POWERUP_TYPES[data.powerupType];
      effect.type = data.powerupType;
      effect.remaining = def.duration;
      flashAlpha.v = 0.55;
    }
  });
}

// ─── Name, Start Pos, etc. ────────────────────────────────────
let _namePrompted = false;
function promptName() { /* your original promptName function - unchanged */ 
  if (_namePrompted || !socket) return;
  _namePrompted = true;
  const modal = document.createElement('div');
  modal.style.cssText = `position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); background:rgba(7,9,20,0.95); border:2px solid #00e5ff; padding:30px 40px; border-radius:12px; color:#fff; font-family:system-ui; z-index:1000; text-align:center; box-shadow:0 0 40px rgba(0,229,255,0.3);`;
  modal.innerHTML = `<div style="font-size:18px;margin-bottom:16px">Enter your name</div>
    <input id="nameInput" maxlength="16" value="Player" style="padding:10px 16px;font-size:18px;width:220px;background:#111;border:1px solid #00e5ff;color:#fff;border-radius:6px;">
    <br><button id="nameBtn" style="margin-top:16px;padding:10px 32px;background:#00e5ff;color:#000;border:none;border-radius:6px;font-weight:700;cursor:pointer;">Join</button>`;
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

const START_POSITIONS = [ /* your original array */ 
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

// Send input, redrawTerritoryCanvas, hexPath, rebuildMinimap, renderMinimap — all kept as-is (your original code)

// ─── Update with Remote Interpolation ────────────────────────
function update(dt) {
  const _eff = effect.type ? POWERUP_TYPES[effect.type] : null;
  const currentSpeed = _eff ? SPEED * _eff.speedMult : SPEED;
  const currentSteer = _eff ? 0.15 * _eff.steerMult : 0.15;

  // Local Prediction
  let moved = false;
  if (joy.active && (joy.dx || joy.dy)) {
    const target = Math.atan2(joy.dy, joy.dx);
    player.angle = lerpAngle(player.angle, target, currentSteer);
    moved = true;
  } else if (input.active) {
    const wx = input.x + camera.x, wy = input.y + camera.y;
    const ddx = wx - player.x, ddy = wy - player.y;
    if (Math.hypot(ddx, ddy) > 10) {
      const target = Math.atan2(ddy, ddx);
      player.angle = lerpAngle(player.angle, target, currentSteer);
      moved = true;
    }
  }

  if (moved) {
    player.x += Math.cos(player.angle) * currentSpeed;
    player.y += Math.sin(player.angle) * currentSpeed;

    const dist = Math.hypot(player.x - CX, player.y - CY);
    if (dist > RADIUS) {
      const nx = (player.x - CX) / dist;
      const ny = (player.y - CY) / dist;
      player.x = CX + nx * RADIUS;
      player.y = CY + ny * RADIUS;
    }
  }

  // Local trail logic
  const [pc, pr] = worldToCell(player.x, player.y);
  const onOwn = getG(pc, pr) === (mySlot + 1);
  const _trailDist = _eff ? TRAIL_DIST * _eff.trailDistMult : TRAIL_DIST;

  if (!player.outside) {
    if (!onOwn) {
      player.outside = true;
      player.trail = [{x: player.x, y: player.y}];
    }
  } else {
    const last = player.trail[player.trail.length-1];
    if (Math.hypot(player.x - last.x, player.y - last.y) >= _trailDist) {
      player.trail.push({x: player.x, y: player.y});
    }
    if (onOwn) {
      player.outside = false;
      player.trail = [];
    }
  }

  // Remote Interpolation (this was missing!)
  for (const rp of remotePlayers.values()) {
    if (rp.targetX !== undefined) {
      rp.x = (rp.x || rp.targetX) * 0.65 + rp.targetX * 0.35;
      rp.y = (rp.y || rp.targetY) * 0.65 + rp.targetY * 0.35;
      rp.angle = lerpAngle(rp.angle || 0, rp.targetAngle || 0, 0.55);
    }
  }

  // Timers
  if (effect.type && effect.remaining !== Infinity) {
    effect.remaining -= dt;
    if (effect.remaining <= 0) { effect.type = null; effect.remaining = 0; }
  }
  if (powerup.active) powerup.despawnTimer -= dt;

  // Camera
  const tx = player.x - canvas.width/2;
  const ty = player.y - canvas.height/2;
  camera.x += (tx - camera.x) * 0.12;
  camera.y += (ty - camera.y) * 0.12;

  // FX + FPS
  globalTime += dt;
  for (let i = pulses.length-1; i >= 0; i--) {
    pulses[i].age += dt;
    if (pulses[i].age > pulses[i].dur) pulses.splice(i,1);
  }
  flashAlpha.v *= 0.88;

  fpsFrames++; fpsAccum += dt;
  if (fpsAccum >= 1000) { fps = fpsFrames; fpsFrames = 0; fpsAccum -= 1000; }

  sendInput(dt);
}

function lerpAngle(cur, tgt, t) {
  let d = tgt - cur;
  while (d > Math.PI) d -= Math.PI*2;
  while (d < -Math.PI) d += Math.PI*2;
  return cur + d * t;
}

// Keep all your render(), renderMinimap(), renderKillFeed(), renderHUD(), injectUIElements(), etc. exactly as they were.

function loop(ts) {
  const dt = Math.min(ts - lastTime, 50);
  lastTime = ts;
  update(dt);
  render();
  requestAnimationFrame(loop);
}

init();
requestAnimationFrame(loop);
