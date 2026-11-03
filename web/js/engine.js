// Blockfall — moteur de jeu pur : aucun DOM, aucun hasard caché, aucune horloge, que des entiers.
// Mêmes entrées => mêmes résultats, à l'image près. Il existe aussi en PHP (src/Engine) : les vecteurs de
// tests/fixtures/engine-vectors.json gardent les deux identiques.
//
// Une grille de 10 colonnes × 22 rangées (les deux du haut sont cachées), pièces et rotations SRS avec rebonds contre les murs,
// sacs de sept, gravité par niveau, délai de verrouillage, DAS / ARR, mise en réserve, lignes envoyées à l'adversaire.

export const C = Object.freeze({
  COLS: 10,
  ROWS: 22,
  HIDDEN: 2,          // rangées cachées en haut
  DAS: 10,            // images avant la répétition automatique d'un déplacement
  ARR: 2,             // images entre deux répétitions
  SOFT: 2,            // images par rangée en chute douce
  LOCK_DELAY: 30,     // images posée au sol avant de se figer
  MAX_RESETS: 15,     // remises à zéro du délai par pièce
  ARE: 8,             // images entre deux pièces
  CLEAR_ARE: 20,      // idem après une ligne
  GARBAGE_CAP: 8,     // lignes reçues au plus à chaque pose
  QUEUE: 6,           // pièces à venir tenues en avance
  TIME_LEVEL: 1800,   // images par niveau en duel
  MAX_LEVEL: 20,
});

// Gravité : rangées par image × 65536, du niveau 1 au niveau 20 (formule des lignes directrices, plafonnée à 20 rangées par image).
export const GRAVITY = Object.freeze([0, 1092, 1377, 1768, 2311, 3075, 4169, 5759, 8107, 11634, 17026, 25416, 38709, 60169, 95483, 154742, 256187, 433425, 749597, 1310720, 1310720]);

export const I = 0; export const O = 1; export const T = 2; export const S = 3; export const Z = 4; export const J = 5; export const L = 6;
export const NAMES = Object.freeze(['I', 'O', 'T', 'S', 'Z', 'J', 'L']);

const BASE = [
  { n: 4, c: [[0, 1], [1, 1], [2, 1], [3, 1]] },   // I
  { n: 4, c: [[1, 0], [2, 0], [1, 1], [2, 1]] },   // O
  { n: 3, c: [[1, 0], [0, 1], [1, 1], [2, 1]] },   // T
  { n: 3, c: [[1, 0], [2, 0], [0, 1], [1, 1]] },   // S
  { n: 3, c: [[0, 0], [1, 0], [1, 1], [2, 1]] },   // Z
  { n: 3, c: [[0, 0], [0, 1], [1, 1], [2, 1]] },   // J
  { n: 3, c: [[2, 0], [0, 1], [1, 1], [2, 1]] },   // L
];

/** SHAPES[type][rotation] = quatre cases [x, y] dans la boîte de la pièce. */
export const SHAPES = BASE.map(({ n, c }, type) => {
  const rots = [c];
  for (let r = 1; r < 4; r++) rots.push(type === O ? c : rots[r - 1].map(([x, y]) => [n - 1 - y, x]));
  return rots;
});

// Rebonds SRS : [dx, dy vers le HAUT] à essayer dans l'ordre, selon (rotation de départ → rotation d'arrivée).
const KICK_3 = {
  '01': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]], '10': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '12': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]], '21': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '23': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]], '32': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '30': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]], '03': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
};
const KICK_I = {
  '01': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]], '10': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '12': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]], '21': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '23': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]], '32': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '30': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]], '03': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
};

const COMBO_BONUS = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 5];
const LINE_POINTS = [0, 100, 300, 500, 800];
const ATTACK = [0, 0, 1, 2, 4];

/** Générateur xorshift32 (entiers 32 bits : exactement le même en PHP). */
function rand(b, key) {
  let s = b[key];
  s ^= s << 13;
  s ^= s >>> 17;
  s ^= s << 5;
  s >>>= 0;
  b[key] = s;
  return s;
}

function refill(b) {
  while (b.queue.length < C.QUEUE) {
    const bag = [0, 1, 2, 3, 4, 5, 6];
    for (let i = 6; i > 0; i--) {
      const j = rand(b, 'rng') % (i + 1);
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    b.queue.push(...bag);
  }
}

/** Crée un plateau. `mode` : 'marathon' (le niveau monte avec les lignes) ou 'versus' (il monte avec le temps). */
export function createBoard({ seed, garbageSeed = (seed ^ 0x9e3779b9) >>> 0, mode = 'marathon', startLevel = 1 }) {
  const b = {
    mode,
    startLevel,
    rng: (seed >>> 0) || 1,
    grng: (garbageSeed >>> 0) || 1,
    queue: [],
    grid: Array.from({ length: C.ROWS }, () => new Array(C.COLS).fill(0)),
    piece: null,
    pieceId: 0,
    hold: -1,
    canHold: true,
    gAcc: 0,
    softAcc: 0,
    lockTimer: 0,
    lockResets: 0,
    dasDir: 0,
    dasTimer: 0,
    are: C.ARE,
    score: 0,
    lines: 0,
    level: startLevel,
    combo: -1,
    b2b: false,
    pending: [],
    alive: true,
    frame: 0,
  };
  refill(b);
  return b;
}

export const cellsOf = (type, rot, x, y) => SHAPES[type][rot].map(([cx, cy]) => [x + cx, y + cy]);

export function collides(grid, type, rot, x, y) {
  for (const [cx, cy] of SHAPES[type][rot]) {
    const px = x + cx;
    const py = y + cy;
    if (px < 0 || px >= C.COLS || py < 0 || py >= C.ROWS || grid[py][px] !== 0) return true;
  }
  return false;
}

/** Rangée où la pièce se poserait si on la lâchait (fantôme). */
export function dropY(grid, type, rot, x, y) {
  let yy = y;
  while (!collides(grid, type, rot, x, yy + 1)) yy++;
  return yy;
}

function levelOf(b) {
  const lv = b.mode === 'versus' ? 1 + Math.floor(b.frame / C.TIME_LEVEL) : b.startLevel + Math.floor(b.lines / 10);
  return Math.min(C.MAX_LEVEL, lv);
}

function spawnPiece(b, type) {
  b.piece = { type, rot: 0, x: 3, y: 0 };
  b.pieceId++;
  b.lockTimer = 0;
  b.lockResets = 0;
  b.gAcc = 0;
  if (collides(b.grid, type, 0, 3, 0)) b.alive = false;       // plus de place : perdu
}

function spawn(b, ev) {
  const type = b.queue.shift();
  refill(b);
  spawnPiece(b, type);
  if (!b.alive) ev.push({ t: 'dead' });
}

const grounded = (b) => collides(b.grid, b.piece.type, b.piece.rot, b.piece.x, b.piece.y + 1);

function shift(b, dx, dy) {
  const p = b.piece;
  if (collides(b.grid, p.type, p.rot, p.x + dx, p.y + dy)) return false;
  p.x += dx;
  p.y += dy;
  return true;
}

/** Après un déplacement ou une rotation réussis au sol : le délai de verrouillage repart (dans la limite des remises). */
function touched(b) {
  if (grounded(b) && b.lockResets < C.MAX_RESETS) {
    b.lockTimer = 0;
    b.lockResets++;
  }
}

function move(b, dx) {
  if (shift(b, dx, 0)) touched(b);
}

/** Rotation avec rebonds SRS. `dir` : 1 = horaire, -1 = anti-horaire. */
export function rotatePiece(grid, p, dir) {
  const to = (p.rot + dir + 4) % 4;
  if (p.type === O) return { rot: to, x: p.x, y: p.y };
  const kicks = (p.type === I ? KICK_I : KICK_3)[`${p.rot}${to}`];
  for (const [kx, ky] of kicks) {
    const nx = p.x + kx;
    const ny = p.y - ky;
    if (!collides(grid, p.type, to, nx, ny)) return { rot: to, x: nx, y: ny };
  }
  return null;
}

function rotate(b, dir) {
  const r = rotatePiece(b.grid, b.piece, dir);
  if (!r) return;
  b.piece.rot = r.rot;
  b.piece.x = r.x;
  b.piece.y = r.y;
  touched(b);
}

function holdPiece(b, ev) {
  if (!b.canHold) return;
  const cur = b.piece.type;
  b.canHold = false;
  ev.push({ t: 'hold' });
  if (b.hold < 0) {
    b.hold = cur;
    b.piece = null;
    spawn(b, ev);
    b.canHold = false;
  } else {
    const swap = b.hold;
    b.hold = cur;
    spawnPiece(b, swap);
    if (!b.alive) ev.push({ t: 'dead' });
  }
}

function applyGarbage(b, ev) {
  let total = 0;
  while (b.pending.length > 0 && total < C.GARBAGE_CAP) {
    const take = Math.min(b.pending[0], C.GARBAGE_CAP - total);
    total += take;
    b.pending[0] -= take;
    if (b.pending[0] === 0) b.pending.shift();
    const hole = rand(b, 'grng') % C.COLS;
    for (let k = 0; k < take; k++) {
      const row = new Array(C.COLS).fill(8);
      row[hole] = 0;
      b.grid.shift();
      b.grid.push(row);
    }
  }
  if (total > 0) ev.push({ t: 'garbage', n: total });
}

function lockPiece(b, ev) {
  const p = b.piece;
  let lockOut = true;
  for (const [x, y] of cellsOf(p.type, p.rot, p.x, p.y)) {
    b.grid[y][x] = p.type + 1;
    if (y >= C.HIDDEN) lockOut = false;
  }
  b.piece = null;
  b.canHold = true;
  ev.push({ t: 'lock' });
  const rows = [];
  for (let y = 0; y < C.ROWS; y++) if (b.grid[y].every((v) => v !== 0)) rows.push(y);
  if (rows.length > 0) {
    const kept = b.grid.filter((_, y) => !rows.includes(y));
    b.grid = [...Array.from({ length: rows.length }, () => new Array(C.COLS).fill(0)), ...kept];
    const n = rows.length;
    b.combo++;
    let pts = LINE_POINTS[n] * b.level;
    if (n === 4 && b.b2b) pts = Math.floor((pts * 3) / 2);
    pts += 50 * b.combo * b.level;
    b.score += pts;
    b.lines += n;
    let attack = ATTACK[n] + (n === 4 && b.b2b ? 1 : 0) + COMBO_BONUS[Math.min(b.combo, COMBO_BONUS.length - 1)];
    b.b2b = n === 4;
    while (attack > 0 && b.pending.length > 0) {          // les lignes envoyées annulent d'abord celles qu'on allait recevoir
      const t = Math.min(b.pending[0], attack);
      b.pending[0] -= t;
      attack -= t;
      if (b.pending[0] === 0) b.pending.shift();
    }
    ev.push({ t: 'clear', rows, n });
    if (attack > 0) ev.push({ t: 'attack', n: attack });
    b.are = C.CLEAR_ARE;
  } else {
    b.combo = -1;
    applyGarbage(b, ev);
    b.are = C.ARE;
  }
  if (lockOut) {
    b.alive = false;
    ev.push({ t: 'dead' });
  }
}

function action(b, a, ev) {
  switch (a) {
    case 'cw': rotate(b, 1); break;
    case 'ccw': rotate(b, -1); break;
    case 'hold': holdPiece(b, ev); break;
    case 'hd': {
      let d = 0;
      while (shift(b, 0, 1)) d++;
      b.score += 2 * d;
      lockPiece(b, ev);
      break;
    }
    default: break;
  }
}

/**
 * Avance d'une image (1/60 s). `input` : { l, r, d } touches tenues, `a` : actions pressées pendant cette image
 * ('cw', 'ccw', 'hd', 'hold'). Renvoie les événements : lock, clear, attack, garbage, hold, dead.
 */
export function step(b, input, ev = []) {
  if (!b.alive) return ev;
  b.frame++;
  b.level = levelOf(b);
  const dir = input.r && !input.l ? 1 : input.l && !input.r ? -1 : 0;
  if (dir !== b.dasDir) {
    b.dasDir = dir;
    b.dasTimer = 0;
    if (dir !== 0 && b.piece) move(b, dir);
  } else if (dir !== 0) {
    b.dasTimer++;
    if (b.dasTimer >= C.DAS && (b.dasTimer - C.DAS) % C.ARR === 0 && b.piece) move(b, dir);
  }
  for (const a of input.a ?? []) {
    if (!b.piece || !b.alive) break;
    action(b, a, ev);
  }
  if (!b.alive) return ev;
  if (b.piece) {
    if (input.d) {
      if (++b.softAcc >= C.SOFT) {
        b.softAcc = 0;
        if (shift(b, 0, 1)) b.score += 1;
      }
    } else {
      b.softAcc = 0;
    }
    b.gAcc += GRAVITY[b.level];
    while (b.gAcc >= 65536) {
      b.gAcc -= 65536;
      if (!shift(b, 0, 1)) {
        b.gAcc = 0;
        break;
      }
    }
    if (grounded(b)) {
      if (++b.lockTimer >= C.LOCK_DELAY) lockPiece(b, ev);
    } else {
      b.lockTimer = 0;
    }
  } else if (--b.are <= 0) {
    spawn(b, ev);
  }
  return ev;
}

// ------------------------------------------------------------------------------------------------ duel
/** Un duel : deux plateaux avec la même suite de pièces ; les lignes envoyées arrivent chez l'adversaire à l'image suivante. */
export function createVersus({ seed }) {
  return {
    boards: [createBoard({ seed, garbageSeed: (seed + 1) >>> 0, mode: 'versus' }), createBoard({ seed, garbageSeed: (seed + 2) >>> 0, mode: 'versus' })],
    frame: 0,
    winner: null,
  };
}

/** Avance le duel d'une image. `inputs` : [entrée du plateau 0, entrée du plateau 1]. Renvoie les événements de chaque plateau. */
export function stepVersus(m, inputs) {
  const evs = [[], []];
  if (m.winner !== null) return evs;
  m.frame++;
  for (const i of [0, 1]) step(m.boards[i], inputs[i], evs[i]);
  for (const i of [0, 1]) for (const e of evs[i]) if (e.t === 'attack') m.boards[1 - i].pending.push(e.n);
  const [a, b] = m.boards;
  if (!a.alive || !b.alive) m.winner = a.alive ? 0 : b.alive ? 1 : a.score >= b.score ? 0 : 1;
  return evs;
}

/** Les lignes qui attendent d'arriver chez ce plateau. */
export const pendingLines = (b) => b.pending.reduce((s, n) => s + n, 0);

/** Grille visible (20 rangées) sous forme de texte : un chiffre par case (0 vide, 1-7 pièces, 8 lignes reçues). */
export function gridString(b) {
  let s = '';
  for (let y = C.HIDDEN; y < C.ROWS; y++) s += b.grid[y].join('');
  return s;
}

/** Résumé d'un plateau : de quoi l'afficher, le comparer ou l'envoyer. */
export function snapshot(b) {
  return {
    g: gridString(b),
    p: b.piece ? [b.piece.type, b.piece.rot, b.piece.x, b.piece.y] : null,
    q: b.queue.slice(0, 5),
    h: b.hold,
    ch: b.canHold,
    sc: b.score,
    ln: b.lines,
    lv: b.level,
    pg: pendingLines(b),
    al: b.alive,
  };
}
