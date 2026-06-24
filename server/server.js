'use strict';
/**
 * Territory.io — Multiplayer Server
 * Node.js + Socket.IO
 * Deploy to Render Free Tier
 */

const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 10000,
  pingTimeout:  20000,
});

// ── Constants (must match client) ────────────────────────────
const CELL       = 20;
const COLS       = 200;
const ROWS       = 200;
const W          = COLS * CELL;
const H          = ROWS * CELL;
const CX         = W / 2;
const CY         = H / 2;
const RADIUS     = Math.min(W, H) / 2 - CELL;
const SPEED      = 2.6;
const TRAIL_DIST = 6;
const START_HALF = 5;
const MAX_PLAYERS = 10;
const TICK_RATE   = 50; // ms per server tick (20Hz)

// Powerup settings
const POWERUP_PICKUP_R  = 20;
const POWERUP_RESPAWN   = 22000;
const POWERUP_DESPAWN   = 12000;
const POWERUP_TYPES = {
  overcharge: { weight:3, duration:8000,     speedMult:1.4, steerMult:0.55, scoreMult:2,  trailDistMult:0.5 },
  shield:     { weight:3, duration:Infinity,  speedMult:1,   steerMult:1,    scoreMult:1,  trailDistMult:1   },
  phantom:    { weight:2, duration:6000,      speedMult:0.8, steerMult:1,    scoreMult:1,  trailDistMult:1   },
};

// Player colours (one per slot)
const PLAYER_COLORS = [
  { fill:'#00b8d4', glow:'#00e5ff', trail:'#00e5ff' }, // cyan  (you)
  { fill:'#e53935', glow:'#ff5252', trail:'#ff5252' }, // red
  { fill:'#43a047', glow:'#69f0ae', trail:'#69f0ae' }, // green
  { fill:'#fb8c00', glow:'#ffb300', trail:'#ffb300' }, // orange
  { fill:'#8e24aa', glow:'#ea80fc', trail:'#ea80fc' }, // purple
  { fill:'#00897b', glow:'#64ffda', trail:'#64ffda' }, // teal
  { fill:'#f06292', glow:'#ff80ab', trail:'#ff80ab' }, // pink
  { fill:'#fdd835', glow:'#ffff00', trail:'#ffff00' }, // yellow
  { fill:'#5e35b1', glow:'#b388ff', trail:'#b388ff' }, // indigo
  { fill:'#6d4c41', glow:'#bcaaa4', trail:'#bcaaa4' }, // brown
];

// Starting positions spaced around the map
const START_POSITIONS = [
  { x: CX,           y: CY           },
  { x: CX - 600,     y: CY - 600     },
  { x: CX + 600,     y: CY - 600     },
  { x: CX - 600,     y: CY + 600     },
  { x: CX + 600,     y: CY + 600     },
  { x: CX,           y: CY - 800     },
  { x: CX,           y: CY + 800     },
  { x: CX - 800,     y: CY           },
  { x: CX + 800,     y: CY           },
  { x: CX - 400,     y: CY + 900     },
];

// ── Server state ─────────────────────────────────────────────
// Shared grid: 0=unclaimed, values 1-10 = owned by player slot
const grid = new Uint8Array(COLS * ROWS);

const players = new Map(); // socketId → playerState
let   colorSlots = new Array(MAX_PLAYERS).fill(false); // which colour slots are taken
let   slotPositions = [...START_POSITIONS];

// Powerup
const powerup = {
  x:0, y:0, active:false, type:null,
  respawnTimer: 3000, despawnTimer: 0,
};

function gi(c,r)       { return r*COLS+c; }
function inBounds(c,r) { return c>=0&&c<COLS&&r>=0&&r<ROWS; }
function getG(c,r)     { return inBounds(c,r)?grid[gi(c,r)]:0; }
function setG(c,r,v)   { if(inBounds(c,r)) grid[gi(c,r)]=v; }
function worldToCell(x,y) { return [Math.floor(x/CELL), Math.floor(y/CELL)]; }

function allocSlot() {
  for (let i=0;i<MAX_PLAYERS;i++) {
    if (!colorSlots[i]) { colorSlots[i]=true; return i; }
  }
  return -1;
}
function freeSlot(i) { if(i>=0) colorSlots[i]=false; }

// ── Territory helpers ─────────────────────────────────────────
function claimStartSquare(slot, startX, startY) {
  const c0 = Math.floor(startX/CELL) - START_HALF;
  const r0 = Math.floor(startY/CELL) - START_HALF;
  let count = 0;
  for (let r=r0; r<r0+START_HALF*2; r++) {
    for (let c=c0; c<c0+START_HALF*2; c++) {
      if (inBounds(c,r) && grid[gi(c,r)]===0) {
        grid[gi(c,r)] = slot+1; // slots 1-based in grid
        count++;
      }
    }
  }
  return count;
}

function captureFloodFill(trail, slot) {
  if (trail.length < 3) return 0;
  const playerGridVal = slot+1;

  const mask = new Uint8Array(COLS*ROWS);
  for (let i=0;i<grid.length;i++) {
    if (grid[i]===playerGridVal) mask[i]=1; // own territory = wall
  }

  function paintLine(x0,y0,x1,y1) {
    let [c0,r0]      = worldToCell(x0,y0);
    const [c1,r1]    = worldToCell(x1,y1);
    const dc=Math.abs(c1-c0), dr=Math.abs(r1-r0);
    const sc=c0<c1?1:-1, sr=r0<r1?1:-1;
    let err=dc-dr;
    for(;;){
      if(inBounds(c0,r0)) mask[gi(c0,r0)]=2;
      if(c0===c1&&r0===r1) break;
      const e2=2*err;
      if(e2>-dr){err-=dr;c0+=sc;}
      if(e2< dc){err+=dc;r0+=sr;}
    }
  }
  for(let i=0;i<trail.length-1;i++)
    paintLine(trail[i].x,trail[i].y,trail[i+1].x,trail[i+1].y);
  paintLine(trail[trail.length-1].x,trail[trail.length-1].y,trail[0].x,trail[0].y);

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
  const stolen = {}; // slotVal → count stolen from them
  for(let i=0;i<mask.length;i++){
    if(grid[i]===playerGridVal) continue;
    if(mask[i]!==OUT){
      const prev = grid[i];
      if (prev > 0) stolen[prev] = (stolen[prev]||0)+1;
      grid[i]=playerGridVal;
      gained++;
    }
  }
  return { gained, stolen };
}

// Check if any player's trail is at a given cell (for kill detection)
function trailOccupiesCell(c, r, excludeSlot) {
  for (const [, p] of players) {
    if (p.slot === excludeSlot) continue;
    if (!p.outside || !p.trail.length) continue;
    for (const pt of p.trail) {
      const [tc, tr] = worldToCell(pt.x, pt.y);
      if (tc===c && tr===r) return p;
    }
  }
  return null;
}

// ── Powerup ──────────────────────────────────────────────────
function spawnPowerup() {
  const keys    = Object.keys(POWERUP_TYPES);
  const weights = keys.map(k=>POWERUP_TYPES[k].weight);
  const total   = weights.reduce((a,b)=>a+b,0);
  let rand = Math.random()*total, chosen=keys[0];
  for(let i=0;i<keys.length;i++){rand-=weights[i];if(rand<=0){chosen=keys[i];break;}}
  powerup.type=chosen;
  for(let attempt=0;attempt<40;attempt++){
    const angle=Math.random()*Math.PI*2;
    const r    =Math.random()*RADIUS*0.72+RADIUS*0.12;
    const px   =CX+Math.cos(angle)*r;
    const py   =CY+Math.sin(angle)*r;
    const[gc,gr]=worldToCell(px,py);
    if(getG(gc,gr)===0){
      powerup.x=px; powerup.y=py; powerup.active=true;
      powerup.despawnTimer=POWERUP_DESPAWN;
      return;
    }
  }
  powerup.x=CX; powerup.y=CY;
  powerup.active=true;
  powerup.despawnTimer=POWERUP_DESPAWN;
}

// ── Kill a player ─────────────────────────────────────────────
function killPlayer(victim, killerSlot, killerName, reason) {
  victim.outside = false;
  victim.trail   = [];
  victim.x = START_POSITIONS[victim.slot].x;
  victim.y = START_POSITIONS[victim.slot].y;
  victim.angle = 0;

  const killerName2 = killerName || 'the void';
  // Emit kill event to all
  io.emit('playerKilled', {
    victimId:   victim.id,
    victimName: victim.name,
    victimSlot: victim.slot,
    killerSlot,
    killerName: killerName2,
    reason,
  });
}

// ── Compute leaderboard ───────────────────────────────────────
function buildLeaderboard() {
  const counts = new Array(MAX_PLAYERS+1).fill(0);
  for (let i=0;i<grid.length;i++) if(grid[i]>0) counts[grid[i]]++;
  const entries = [];
  for (const [, p] of players) {
    entries.push({ id:p.id, name:p.name, slot:p.slot, cells:counts[p.slot+1], score:p.score });
  }
  entries.sort((a,b)=>b.score-a.score);
  return entries;
}

// ── Game tick ─────────────────────────────────────────────────
let lastTick = Date.now();
function tick() {
  const now = Date.now();
  const dt  = now - lastTick;
  lastTick  = now;

  // Powerup timer
  if (!powerup.active) {
    powerup.respawnTimer -= dt;
    if (powerup.respawnTimer <= 0) spawnPowerup();
  } else {
    powerup.despawnTimer -= dt;
    if (powerup.despawnTimer <= 0) {
      powerup.active       = false;
      powerup.respawnTimer = POWERUP_RESPAWN * 0.5;
      io.emit('powerupState', { active:false });
    }
  }

  // Update each player
  for (const [, p] of players) {
    if (p.dead) continue;

    // Steering
    const eff    = p.effect.type ? POWERUP_TYPES[p.effect.type] : null;
    const speed  = eff ? SPEED*eff.speedMult : SPEED;
    const steer  = eff ? 0.15*eff.steerMult  : 0.15;

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

    // Territory logic
    const [pc,pr] = worldToCell(p.x,p.y);
    const cellVal = getG(pc,pr);
    const onOwn   = cellVal === p.slot+1;
    const _trailDist = eff ? TRAIL_DIST*eff.trailDistMult : TRAIL_DIST;

    if (!p.outside) {
      if (!onOwn) {
        p.outside = true;
        p.trail   = [{ x:p.x, y:p.y }];
      }
    } else {
      // Record trail
      const last = p.trail[p.trail.length-1];
      if (Math.hypot(p.x-last.x, p.y-last.y) >= _trailDist) {
        p.trail.push({ x:p.x, y:p.y });
      }

      // Check if we ran into our OWN trail (self-cut) — phantom immune
      if (p.effect.type !== 'phantom' && p.trail.length > 10) {
        for (let i=0; i<p.trail.length-5; i++) {
          const [tc,tr] = worldToCell(p.trail[i].x, p.trail[i].y);
          if (tc===pc && tr===pr) {
            if (p.effect.type === 'shield') {
              p.effect.type = null; p.effect.remaining = 0;
            } else {
              killPlayer(p, p.slot, 'themselves', 'self');
            }
            break;
          }
        }
      }

      // Check if we're on another player's trail (kill them)
      for (const [, other] of players) {
        if (other.slot === p.slot || !other.outside) continue;
        for (let i=0; i<other.trail.length; i++) {
          const [tc,tr] = worldToCell(other.trail[i].x, other.trail[i].y);
          if (tc===pc && tr===pr) {
            // p cuts other's trail → kill other
            if (other.effect.type === 'shield') {
              other.effect.type = null; other.effect.remaining = 0;
            } else {
              killPlayer(other, p.slot, p.name, 'trail_cut');
            }
            break;
          }
        }
      }

      // Check if an enemy is on OUR trail
      if (!p.dead && p.outside) {
        for (const [, other] of players) {
          if (other.slot === p.slot) continue;
          const [oc,or2] = worldToCell(other.x, other.y);
          for (const pt of p.trail) {
            const [tc,tr] = worldToCell(pt.x, pt.y);
            if (tc===oc && tr===or2) {
              if (p.effect.type === 'shield') {
                p.effect.type = null; p.effect.remaining = 0;
              } else {
                killPlayer(p, other.slot, other.name, 'trail_cut');
              }
              break;
            }
          }
        }
      }

      // Returned to own territory → capture
      if (!p.dead && onOwn && p.outside) {
        p.trail.push({ x:p.x, y:p.y });
        const { gained, stolen } = captureFloodFill(p.trail, p.slot);
        if (gained > 0) {
          const mult = (eff&&eff.scoreMult)?eff.scoreMult:1;
          p.score   += gained * mult;
          // Notify clients of grid update (send changed cells)
          io.emit('gridUpdate', buildGridDelta());
          io.emit('leaderboard', buildLeaderboard());
        }
        p.outside = false;
        p.trail   = [];
      }
    }

    // Effect timer
    if (p.effect.type && p.effect.remaining !== Infinity) {
      p.effect.remaining -= dt;
      if (p.effect.remaining <= 0) { p.effect.type=null; p.effect.remaining=0; }
    }

    // Powerup pickup
    if (powerup.active) {
      const pdx=p.x-powerup.x, pdy=p.y-powerup.y;
      if (Math.hypot(pdx,pdy)<POWERUP_PICKUP_R) {
        const def          = POWERUP_TYPES[powerup.type];
        p.effect.type      = powerup.type;
        p.effect.remaining = def.duration;
        powerup.active     = false;
        powerup.respawnTimer = POWERUP_RESPAWN;
        io.emit('powerupPickup', { playerId:p.id, playerSlot:p.slot, powerupType:powerup.type });
        io.emit('powerupState',  { active:false });
      }
    }
  }

  // Broadcast player positions
  const playerList = [];
  for (const [,p] of players) {
    playerList.push({
      id: p.id, slot:p.slot, name:p.name,
      x:p.x, y:p.y, angle:p.angle,
      outside:p.outside,
      trail:  p.trail,
      effectType: p.effect.type,
    });
  }
  io.emit('playerPositions', playerList);
  if (powerup.active) {
    io.emit('powerupState', { active:true, x:powerup.x, y:powerup.y, type:powerup.type, despawnTimer:powerup.despawnTimer });
  }
}

// Send a compact grid representation (full grid — clients store it)
let _gridSentOnce = false;
function buildGridDelta() {
  // Send full grid as base64 for efficiency
  return Buffer.from(grid.buffer).toString('base64');
}

// ── Socket.IO ─────────────────────────────────────────────────
io.on('connection', socket => {
  if (players.size >= MAX_PLAYERS) {
    socket.emit('roomFull');
    socket.disconnect(true);
    return;
  }

  const slot = allocSlot();
  if (slot < 0) {
    socket.emit('roomFull');
    socket.disconnect(true);
    return;
  }

  const startPos = START_POSITIONS[slot % START_POSITIONS.length];
  const name     = `Player ${slot+1}`;

  const p = {
    id:       socket.id,
    slot,
    name,
    x:        startPos.x,
    y:        startPos.y,
    angle:    0,
    inputDx:  0,
    inputDy:  0,
    outside:  false,
    trail:    [],
    score:    0,
    effect:   { type:null, remaining:0 },
    dead:     false,
  };

  claimStartSquare(slot, startPos.x, startPos.y);
  players.set(socket.id, p);

  // Send init packet to the joining player
  socket.emit('init', {
    myId:    socket.id,
    mySlot:  slot,
    myName:  name,
    colors:  PLAYER_COLORS,
    grid:    buildGridDelta(),
    powerup: powerup.active ? { active:true, x:powerup.x, y:powerup.y, type:powerup.type, despawnTimer:powerup.despawnTimer } : { active:false },
    players: [...players.values()].map(pl=>({
      id:pl.id, slot:pl.slot, name:pl.name, x:pl.x, y:pl.y, angle:pl.angle,
      outside:pl.outside, trail:pl.trail, effectType:pl.effect.type,
    })),
  });

  // Notify others
  socket.broadcast.emit('playerJoined', {
    id:slot, slot, name, x:p.x, y:p.y, angle:0,
  });
  io.emit('leaderboard', buildLeaderboard());
  io.emit('gridUpdate', buildGridDelta());

  // Receive player input
  socket.on('input', data => {
    if (!p) return;
    p.inputDx = data.dx || 0;
    p.inputDy = data.dy || 0;
  });

  // Player wants to change name
  socket.on('setName', name => {
    if (typeof name === 'string') {
      p.name = name.slice(0, 16).trim() || p.name;
      io.emit('leaderboard', buildLeaderboard());
    }
  });

  socket.on('disconnect', () => {
    // Remove player's territory? Or keep it. Keep it — more interesting.
    players.delete(socket.id);
    freeSlot(slot);
    io.emit('playerLeft', { id:socket.id, slot });
    io.emit('leaderboard', buildLeaderboard());
  });
});

// ── Start ─────────────────────────────────────────────────────
app.get('/', (_, res) => res.send('Territory.io server running'));

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server listening on :${PORT}`));

// Game loop
setInterval(tick, TICK_RATE);
spawnPowerup();
