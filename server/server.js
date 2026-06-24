'use strict';
/**
 * Territory.io — Multiplayer Server  (FIXED)
 * Node.js + Socket.IO
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 10000,
  pingTimeout:  20000,
});

// ── Constants (must match client) ─────────────────────────────
const CELL        = 20;
const COLS        = 200;
const ROWS        = 200;
const W           = COLS * CELL;
const H           = ROWS * CELL;
const CX          = W / 2;
const CY          = H / 2;
const RADIUS      = Math.min(W, H) / 2 - CELL;
const SPEED       = 2.6;
const TRAIL_DIST  = 6;
const START_HALF  = 5;
const MAX_PLAYERS = 10;
const TICK_RATE   = 50; // ms per tick (20 Hz)

// Powerup settings
const POWERUP_PICKUP_R = 20;
const POWERUP_RESPAWN  = 22000;
const POWERUP_DESPAWN  = 12000;
const POWERUP_TYPES = {
  overcharge: { weight:3, duration:8000,    speedMult:1.4, steerMult:0.55, scoreMult:2, trailDistMult:0.5 },
  shield:     { weight:3, duration:Infinity, speedMult:1,   steerMult:1,    scoreMult:1, trailDistMult:1   },
  phantom:    { weight:2, duration:6000,    speedMult:0.8, steerMult:1,    scoreMult:1, trailDistMult:1   },
};

const PLAYER_COLORS = [
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

const START_POSITIONS = [
  { x:CX,       y:CY       }, { x:CX-600, y:CY-600 }, { x:CX+600, y:CY-600 },
  { x:CX-600,   y:CY+600   }, { x:CX+600, y:CY+600 }, { x:CX,     y:CY-800 },
  { x:CX,       y:CY+800   }, { x:CX-800, y:CY     }, { x:CX+800, y:CY     },
  { x:CX-400,   y:CY+900   },
];

// ── Server state ──────────────────────────────────────────────
const grid       = new Uint8Array(COLS * ROWS);
const players    = new Map();            // socketId → playerState
let   colorSlots = new Array(MAX_PLAYERS).fill(false);

const powerup = {
  x:0, y:0, active:false, type:null,
  respawnTimer: 3000, despawnTimer: 0,
};

// ── Grid helpers ──────────────────────────────────────────────
function gi(c,r)          { return r*COLS+c; }
function inBounds(c,r)    { return c>=0&&c<COLS&&r>=0&&r<ROWS; }
function getG(c,r)        { return inBounds(c,r)?grid[gi(c,r)]:0; }
function setG(c,r,v)      { if(inBounds(c,r)) grid[gi(c,r)]=v; }
function worldToCell(x,y) { return [Math.floor(x/CELL), Math.floor(y/CELL)]; }

function allocSlot() {
  for (let i=0;i<MAX_PLAYERS;i++) if(!colorSlots[i]){ colorSlots[i]=true; return i; }
  return -1;
}
function freeSlot(i) { if(i>=0) colorSlots[i]=false; }

// ── Territory helpers ─────────────────────────────────────────
function claimStartSquare(slot, startX, startY) {
  const c0 = Math.floor(startX/CELL) - START_HALF;
  const r0 = Math.floor(startY/CELL) - START_HALF;
  for (let r=r0; r<r0+START_HALF*2; r++)
    for (let c=c0; c<c0+START_HALF*2; c++)
      if (inBounds(c,r) && grid[gi(c,r)]===0) grid[gi(c,r)] = slot+1;
}

function captureFloodFill(trail, slot) {
  // Need at least a triangle to enclose area
  if (trail.length < 3) return { gained:0, stolen:{} };
  const playerGridVal = slot+1;

  // mask: 1=own territory (wall), 2=trail line, 3=outside (flood), 0=inside candidate
  const mask = new Uint8Array(COLS*ROWS);
  for (let i=0;i<grid.length;i++)
    if (grid[i]===playerGridVal) mask[i]=1;

  // Rasterise trail edges into mask as value 2
  function paintLine(x0,y0,x1,y1) {
    let [c0,r0]   = worldToCell(x0,y0);
    const [c1,r1] = worldToCell(x1,y1);
    const dc=Math.abs(c1-c0), dr=Math.abs(r1-r0);
    const sc=c0<c1?1:-1, sr=r0<r1?1:-1;
    let err=dc-dr;
    for(;;){
      if(inBounds(c0,r0) && mask[gi(c0,r0)]!==1) mask[gi(c0,r0)]=2;
      if(c0===c1&&r0===r1) break;
      const e2=2*err;
      if(e2>-dr){err-=dr;c0+=sc;}
      if(e2< dc){err+=dc;r0+=sr;}
    }
  }
  for (let i=0;i<trail.length-1;i++)
    paintLine(trail[i].x,trail[i].y,trail[i+1].x,trail[i+1].y);
  // Close the loop back to owned territory start
  paintLine(trail[trail.length-1].x,trail[trail.length-1].y,trail[0].x,trail[0].y);

  // Flood-fill from edges to mark outside (value 3)
  const OUT=3;
  const queue=[];
  const push=idx=>{ if(mask[idx]===0){mask[idx]=OUT;queue.push(idx);} };
  for(let c=0;c<COLS;c++){push(gi(c,0));push(gi(c,ROWS-1));}
  for(let r=1;r<ROWS-1;r++){push(gi(0,r));push(gi(COLS-1,r));}
  let head=0;
  while(head<queue.length){
    const idx=queue[head++];
    const c=idx%COLS, r=(idx/COLS)|0;
    if(r>0      && mask[idx-COLS]===0){mask[idx-COLS]=OUT;queue.push(idx-COLS);}
    if(r<ROWS-1 && mask[idx+COLS]===0){mask[idx+COLS]=OUT;queue.push(idx+COLS);}
    if(c>0      && mask[idx-1]   ===0){mask[idx-1]   =OUT;queue.push(idx-1);}
    if(c<COLS-1 && mask[idx+1]   ===0){mask[idx+1]   =OUT;queue.push(idx+1);}
  }

  let gained=0;
  const stolen={};
  for(let i=0;i<mask.length;i++){
    if(mask[i]!==OUT && mask[i]!==1){  // inside area (value 0 or 2) but not own territory yet
      const prev=grid[i];
      if(prev===playerGridVal) continue; // already ours
      if(prev>0) stolen[prev]=(stolen[prev]||0)+1;
      grid[i]=playerGridVal;
      gained++;
    }
  }
  return { gained, stolen };
}

// ── Powerup ───────────────────────────────────────────────────
function spawnPowerup() {
  const keys    = Object.keys(POWERUP_TYPES);
  const weights = keys.map(k=>POWERUP_TYPES[k].weight);
  const total   = weights.reduce((a,b)=>a+b,0);
  let rand=Math.random()*total, chosen=keys[0];
  for(let i=0;i<keys.length;i++){rand-=weights[i];if(rand<=0){chosen=keys[i];break;}}
  powerup.type=chosen;
  for(let attempt=0;attempt<40;attempt++){
    const angle=Math.random()*Math.PI*2;
    const r    =Math.random()*RADIUS*0.72+RADIUS*0.12;
    const px   =CX+Math.cos(angle)*r;
    const py   =CY+Math.sin(angle)*r;
    const[gc,gr]=worldToCell(px,py);
    if(getG(gc,gr)===0){ powerup.x=px; powerup.y=py; powerup.active=true; powerup.despawnTimer=POWERUP_DESPAWN; return; }
  }
  powerup.x=CX; powerup.y=CY; powerup.active=true; powerup.despawnTimer=POWERUP_DESPAWN;
}

// ── BUG FIX #1: killPlayer no longer sets p.dead — respawn is immediate ──
function killPlayer(victim, killerSlot, killerName, reason) {
  victim.outside = false;
  victim.trail   = [];
  // FIX: reset to start position (was already there, but also clear any dead flag)
  victim.x       = START_POSITIONS[victim.slot].x;
  victim.y       = START_POSITIONS[victim.slot].y;
  victim.angle   = 0;
  // FIX: remove dead flag — players were permanently frozen because dead was never cleared
  victim.dead    = false;

  io.emit('playerKilled', {
    victimId:   victim.id,
    victimName: victim.name,
    victimSlot: victim.slot,
    killerSlot,
    killerName: killerName || 'the void',
    reason,
  });
}

// ── Leaderboard ───────────────────────────────────────────────
function buildLeaderboard() {
  const counts = new Array(MAX_PLAYERS+1).fill(0);
  for (let i=0;i<grid.length;i++) if(grid[i]>0) counts[grid[i]]++;
  const entries=[];
  for (const [,p] of players)
    entries.push({ id:p.id, name:p.name, slot:p.slot, cells:counts[p.slot+1], score:p.score });
  entries.sort((a,b)=>b.score-a.score);
  return entries;
}

function buildGridPayload() {
  return Buffer.from(grid.buffer).toString('base64');
}

// ── BUG FIX #2: throttle leaderboard & grid broadcasts ────────
let gridDirty       = false;
let leaderboardDirty= false;
let broadcastTimer  = 0;
const BROADCAST_INTERVAL = 200; // send grid/leaderboard at most every 200ms

// ── Game tick ─────────────────────────────────────────────────
let lastTick = Date.now();
function tick() {
  // Inside tick(), after powerup pickup block, add:
console.log(`Powerup active: ${powerup.active}, Players: ${players.size}`);
function captureFloodFill(trail, slot) {
  if (trail.length < 3) return { gained:0, stolen:{} };

  // ... existing code ...

  // Quick early-out if trail is too small
  if (trail.length < 4) return { gained:0, stolen:{} };
}
  const now = Date.now();
  const dt  = Math.min(now - lastTick, 100); // cap dt to avoid spiral-of-death
  lastTick  = now;

  // Powerup timers
  if (!powerup.active) {
    powerup.respawnTimer -= dt;
    if (powerup.respawnTimer <= 0) {
      spawnPowerup();
      io.emit('powerupState', { active:true, x:powerup.x, y:powerup.y, type:powerup.type, despawnTimer:powerup.despawnTimer });
    }
  } else {
    powerup.despawnTimer -= dt;
    if (powerup.despawnTimer <= 0) {
      powerup.active       = false;
      powerup.respawnTimer = POWERUP_RESPAWN * 0.5;
      io.emit('powerupState', { active:false });
    }
  }

  for (const [, p] of players) {
    // FIX: dead is now always false (cleared in killPlayer), but guard anyway
    if (p.dead) { p.dead=false; continue; }

    // Steering
    const eff   = p.effect.type ? POWERUP_TYPES[p.effect.type] : null;
    const speed = eff ? SPEED*eff.speedMult : SPEED;
    const steer = eff ? 0.15*eff.steerMult  : 0.15;

    if (p.inputDx !== 0 || p.inputDy !== 0) {
      const target = Math.atan2(p.inputDy, p.inputDx);
      let d = target - p.angle;
      while (d >  Math.PI) d -= Math.PI*2;
      while (d < -Math.PI) d += Math.PI*2;
      p.angle += d * steer;
    }

    p.x += Math.cos(p.angle)*speed;
    p.y += Math.sin(p.angle)*speed;

    // Clamp to world circle
    const dx=p.x-CX, dy=p.y-CY, dist=Math.hypot(dx,dy);
    if(dist>RADIUS){ p.x=CX+(dx/dist)*RADIUS; p.y=CY+(dy/dist)*RADIUS; }

    const [pc,pr]    = worldToCell(p.x,p.y);
    const cellVal    = getG(pc,pr);
    const onOwn      = cellVal === p.slot+1;
    const _trailDist = eff ? TRAIL_DIST*eff.trailDistMult : TRAIL_DIST;

    if (!p.outside) {
      if (!onOwn) {
        p.outside = true;
        p.trail   = [{ x:p.x, y:p.y }];
      }
    } else {
      // Record trail point
      const last = p.trail[p.trail.length-1];
      if (Math.hypot(p.x-last.x, p.y-last.y) >= _trailDist)
        p.trail.push({ x:p.x, y:p.y });

      // Self-cut check (phantom immune)
      if (p.effect.type !== 'phantom' && p.trail.length > 10) {
        let selfCut=false;
        for (let i=0; i<p.trail.length-5; i++) {
          const [tc,tr] = worldToCell(p.trail[i].x, p.trail[i].y);
          if (tc===pc && tr===pr) { selfCut=true; break; }
        }
        if (selfCut) {
          if (p.effect.type === 'shield') { p.effect.type=null; p.effect.remaining=0; }
          else { killPlayer(p, p.slot, 'themselves', 'self'); continue; }
        }
      }

      // Cross another player's trail → kill them
      let killedSomeone=false;
      for (const [, other] of players) {
        if (other.slot===p.slot || !other.outside) continue;
        for (let i=0; i<other.trail.length; i++) {
          const [tc,tr] = worldToCell(other.trail[i].x, other.trail[i].y);
          if (tc===pc && tr===pr) {
            if (other.effect.type==='shield'){ other.effect.type=null; other.effect.remaining=0; }
            else killPlayer(other, p.slot, p.name, 'trail_cut');
            killedSomeone=true;
            break;
          }
        }
        if (killedSomeone) break;
      }

      // Enemy on OUR trail → we die
      if (p.outside) {
        let iDied=false;
        for (const [, other] of players) {
          if (other.slot===p.slot) continue;
          const [oc,or2] = worldToCell(other.x, other.y);
          for (const pt of p.trail) {
            const [tc,tr] = worldToCell(pt.x, pt.y);
            if (tc===oc && tr===or2) {
              if (p.effect.type==='shield'){ p.effect.type=null; p.effect.remaining=0; }
              else { killPlayer(p, other.slot, other.name, 'trail_cut'); iDied=true; }
              break;
            }
          }
          if (iDied) break;
        }
        if (iDied) continue;
      }

      // Returned home → capture
      if (onOwn && p.outside) {
        p.trail.push({ x:p.x, y:p.y });
        const { gained } = captureFloodFill(p.trail, p.slot);
        p.outside = false;
        p.trail   = [];
        if (gained > 0) {
          const mult = (eff&&eff.scoreMult) ? eff.scoreMult : 1;
          p.score  += gained * mult;
          // FIX: mark dirty instead of broadcasting inside the loop every capture
          gridDirty        = true;
          leaderboardDirty = true;
        }
      }
    }

    // Effect timer
    if (p.effect.type && p.effect.remaining !== Infinity) {
      p.effect.remaining -= dt;
      if (p.effect.remaining <= 0) { p.effect.type=null; p.effect.remaining=0; }
    }

    // Powerup pickup
    if (powerup.active && Math.hypot(p.x-powerup.x, p.y-powerup.y) < POWERUP_PICKUP_R) {
      const def          = POWERUP_TYPES[powerup.type];
      p.effect.type      = powerup.type;
      p.effect.remaining = def.duration;
      powerup.active     = false;
      powerup.respawnTimer = POWERUP_RESPAWN;
      io.emit('powerupPickup', { playerId:p.id, playerSlot:p.slot, powerupType:powerup.type });
      io.emit('powerupState',  { active:false });
    }
  }

  // Broadcast player positions every tick (cheap)
  const playerList = [];
  for (const [,p] of players)
    playerList.push({ id:p.id, slot:p.slot, name:p.name, x:p.x, y:p.y, angle:p.angle,
                      outside:p.outside, trail:p.trail, effectType:p.effect.type });
  io.emit('playerPositions', playerList);

  // FIX: only emit powerupState when active (was sending every tick regardless)
  if (powerup.active)
    io.emit('powerupState', { active:true, x:powerup.x, y:powerup.y, type:powerup.type, despawnTimer:powerup.despawnTimer });

  // FIX: throttle heavy grid/leaderboard broadcasts
  broadcastTimer += dt;
  if (broadcastTimer >= BROADCAST_INTERVAL) {
    broadcastTimer = 0;
    if (gridDirty)        { io.emit('gridUpdate',  buildGridPayload());    gridDirty=false; }
    if (leaderboardDirty) { io.emit('leaderboard', buildLeaderboard()); leaderboardDirty=false; }
  }
      // Anti-cheat: limit max movement
    const oldX = player.x, oldY = player.y;
    // ... (existing movement code) ...

    const movedDist = Math.hypot(p.x - oldX, p.y - oldY);
    if (movedDist > SPEED * 1.6) {  // allow some powerup headroom
      p.x = oldX;
      p.y = oldY;
    }
}

// ── Socket.IO ─────────────────────────────────────────────────
io.on('connection', socket => {
  if (players.size >= MAX_PLAYERS) {
    socket.emit('roomFull'); socket.disconnect(true); return;
  }
  const slot = allocSlot();
  if (slot < 0) {
    socket.emit('roomFull'); socket.disconnect(true); return;
  }

  const startPos = START_POSITIONS[slot % START_POSITIONS.length];
  const name     = `Player ${slot+1}`;

  const p = {
    id:socket.id, slot, name,
    x:startPos.x, y:startPos.y, angle:0,
    inputDx:0, inputDy:0,
    outside:false, trail:[],
    score:0,
    effect:{ type:null, remaining:0 },
    dead:false,
  };

  claimStartSquare(slot, startPos.x, startPos.y);
  players.set(socket.id, p);

  // Send full state to the joining player
  socket.emit('init', {
    myId:   socket.id,
    mySlot: slot,
    myName: name,
    colors: PLAYER_COLORS,
    grid:   buildGridPayload(),
    powerup: powerup.active
      ? { active:true, x:powerup.x, y:powerup.y, type:powerup.type, despawnTimer:powerup.despawnTimer }
      : { active:false },
    players: [...players.values()].map(pl=>({
      id:pl.id, slot:pl.slot, name:pl.name, x:pl.x, y:pl.y, angle:pl.angle,
      outside:pl.outside, trail:pl.trail, effectType:pl.effect.type,
    })),
  });

  // FIX: broadcast correct socket id (was sending slot number as id, breaking all lookups)
  socket.broadcast.emit('playerJoined', {
    id:socket.id, slot, name, x:p.x, y:p.y, angle:0,
  });

  io.emit('leaderboard', buildLeaderboard());
  // Send fresh grid so new player's start square appears immediately
  io.emit('gridUpdate', buildGridPayload());

  socket.on('input', data => {
    p.inputDx = typeof data.dx==='number' ? Math.max(-1,Math.min(1,data.dx)) : 0;
    p.inputDy = typeof data.dy==='number' ? Math.max(-1,Math.min(1,data.dy)) : 0;
  });

  socket.on('setName', newName => {
    if (typeof newName === 'string') {
      p.name = newName.slice(0,16).trim() || p.name;
      io.emit('leaderboard', buildLeaderboard());
    }
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);
    freeSlot(slot);
    // FIX: send correct id (socket.id) so client can delete from remotePlayers map
    io.emit('playerLeft', { id:socket.id, slot });
    io.emit('leaderboard', buildLeaderboard());
  });
});

// ── Start ─────────────────────────────────────────────────────
app.get('/', (_, res) => res.send('Territory.io server running'));

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server listening on :${PORT}`));

setInterval(tick, TICK_RATE);
spawnPowerup();
