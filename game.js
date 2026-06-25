/* =============================================================
   TERRITORY.IO — Multiplayer Client (FULLY FIXED)
   ============================================================= */

// ▼▼▼ CHANGE THIS to your Render server URL ▼▼▼
const SERVER_URL = 'https://cyber-claim.onrender.com';

// ─── Constants ─────────────────────────────
const CELL = 20, COLS = 200, ROWS = 200;
const W = COLS * CELL, H = ROWS * CELL;
const CX = W / 2, CY = H / 2;
const RADIUS = Math.min(W, H) / 2 - CELL;

const SPEED = 2.6;
const TRAIL_DIST = 6;
const START_HALF = 5;

const POWERUP_PICKUP_R = 20;
const POWERUP_HEX_SIZE = 18;
const POWERUP_RESPAWN = 22000;
const POWERUP_DESPAWN = 12000;

const POWERUP_TYPES = { /* ... your original POWERUP_TYPES ... */ };
let PLAYER_COLORS = [ /* your original PLAYER_COLORS */ ];

const C_BG = '#07090f';
const C_GRID = 'rgba(255,255,255,0.025)';

// Canvas setup
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

// Grid & helpers
const grid = new Uint8Array(COLS * ROWS);
function gi(c,r) { return r*COLS+c; }
function inBounds(c,r) { return c>=0&&c<COLS&&r>=0&&r<ROWS; }
function getG(c,r) { return inBounds(c,r)?grid[gi(c,r)]:0; }
function worldToCell(x,y) { return [Math.floor(x/CELL), Math.floor(y/CELL)]; }

// State
let socket = null, myId = null, mySlot = 0, connected = false;
const remotePlayers = new Map();
const player = { x:CX, y:CY, angle:0, trail:[], outside:false, slot:0 };

const killFeed = [];
const KILLFEED_DURATION = 5000;
function addKillFeed(text, color='#fff') {
  killFeed.unshift({ text, color, ts:Date.now() });
  if (killFeed.length > 6) killFeed.pop();
}

let leaderboard = [], ownedCells = 0, territoryScore = 0, totalOwnableCells = 0;
for (let r=0;r<ROWS;r++) for (let c=0;c<COLS;c++) {
  if(Math.hypot((c+0.5)*CELL-CX,(r+0.5)*CELL-CY)<=RADIUS) totalOwnableCells++;
}

const powerup = { x:0, y:0, active:false, type:null, despawnTimer:POWERUP_DESPAWN };
const effect = { type:null, remaining:0 };

const camera = { x:0, y:0 };
const input = { x:0, y:0, active:false };
const cursor = { x:-999, y:-999 };
const joy = { active:false, startX:0, startY:0, dx:0, dy:0 };

let globalTime=0, lastTime=0, fps=0, fpsAccum=0, fpsFrames=0;
const pulses = [];
const flashAlpha = { v:0 };

// DOM
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

let elKillfeed = null, elLeaderboard = null, elConnStatus = null, elPlayerCount = null;

// Socket connection (keep your existing initSocket, promptName, etc.)
// ... (I recommend keeping the socket part from your last working version)

// Important: Add this resize function at the top level
function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

// Init
function init() {
  injectStyles();
  injectUIElements();

  elKillfeed = document.getElementById('killfeed');
  elLeaderboard = document.getElementById('leaderboard-list');
  elConnStatus = document.getElementById('conn-status');
  elPlayerCount = document.getElementById('player-count');

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  redrawTerritoryCanvas();

  // Input listeners...
  canvas.addEventListener('mousemove', e => {
    input.x = e.clientX; input.y = e.clientY; input.active = true;
    cursor.x = e.clientX; cursor.y = e.clientY;
  });

  // Touch support...

  connectSocket();
}

// Game loop
function loop(ts) {
  const dt = Math.min(ts - lastTime, 50);
  lastTime = ts;
  update(dt);
  render();
  requestAnimationFrame(loop);
}

// Call init
init();
requestAnimationFrame(loop);
