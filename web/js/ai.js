// Blockfall — l'ordinateur. Pour chaque pièce il cherche toutes les positions atteignables (déplacements et rotations SRS depuis
// l'apparition), note chacune (hauteur, trous, aspérités, lignes faites), choisit la meilleure et exécute le trajet touche par touche.
// Le niveau règle sa vitesse, ses erreurs, l'usage de la réserve et l'anticipation de la pièce suivante.
// Le hasard vient d'un générateur à graine : un duel est rejouable.

import { C, SHAPES, collides, dropY, rotatePiece } from './engine.js';

export const LEVELS = Object.freeze({
  easy: { delay: 24, think: 50, mistake: 0.32, hold: false, look: false },
  normal: { delay: 9, think: 18, mistake: 0.1, hold: true, look: false },
  hard: { delay: 4, think: 6, mistake: 0, hold: true, look: true },
});

/** Générateur pseudo-aléatoire déterministe (mulberry32) renvoyant des réels dans [0, 1). */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Grille après pose de la pièce ; renvoie la nouvelle grille (lignes faites retirées) et leur nombre. */
function place(grid, type, rot, x, y) {
  const g = grid.map((row) => row.slice());
  for (const [cx, cy] of SHAPES[type][rot]) g[y + cy][x + cx] = type + 1;
  const kept = g.filter((row) => row.some((v) => v === 0));
  const cleared = C.ROWS - kept.length;
  return { grid: [...Array.from({ length: cleared }, () => new Array(C.COLS).fill(0)), ...kept], cleared };
}

/** Note d'une grille (plus haut = mieux) : poids de l'évaluateur « El-Tetris », un peu durci contre les piles trop hautes. */
function evaluate(grid, cleared) {
  const heights = new Array(C.COLS).fill(0);
  let holes = 0;
  for (let x = 0; x < C.COLS; x++) {
    let seen = false;
    for (let y = 0; y < C.ROWS; y++) {
      if (grid[y][x] !== 0) {
        if (!seen) { heights[x] = C.ROWS - y; seen = true; }
      } else if (seen) {
        holes++;
      }
    }
  }
  let bump = 0;
  for (let x = 0; x < C.COLS - 1; x++) bump += Math.abs(heights[x] - heights[x + 1]);
  const aggregate = heights.reduce((s, h) => s + h, 0);
  const tall = Math.max(0, Math.max(...heights) - 14);
  return -0.51 * aggregate + 0.76 * cleared - 0.36 * holes - 0.18 * bump - 2 * tall;
}

/** Positions atteignables de la pièce depuis son apparition, avec le trajet le plus court : [{ rot, x, y, path }]. */
export function reachable(grid, type) {
  const start = { rot: 0, x: 3, y: 0 };
  if (collides(grid, type, 0, 3, 0)) return [];
  const key = (s) => `${s.rot},${s.x},${s.y}`;
  const seen = new Map([[key(start), { ...start, path: [] }]]);
  const queue = [start];
  const landings = new Map();
  while (queue.length > 0) {
    const s = queue.shift();
    const here = seen.get(key(s));
    const ly = dropY(grid, type, s.rot, s.x, s.y);
    const lk = `${s.rot},${s.x},${ly}`;
    if (!landings.has(lk)) landings.set(lk, { rot: s.rot, x: s.x, y: ly, path: [...here.path, 'hd'] });
    const next = [];
    if (!collides(grid, type, s.rot, s.x - 1, s.y)) next.push([{ rot: s.rot, x: s.x - 1, y: s.y }, 'L']);
    if (!collides(grid, type, s.rot, s.x + 1, s.y)) next.push([{ rot: s.rot, x: s.x + 1, y: s.y }, 'R']);
    for (const [dir, tok] of [[1, 'cw'], [-1, 'ccw']]) {
      const r = rotatePiece(grid, { type, ...s }, dir);
      if (r) next.push([{ rot: r.rot, x: r.x, y: r.y }, tok]);
    }
    for (const [n, tok] of next) {
      const k = key(n);
      if (!seen.has(k)) {
        seen.set(k, { ...n, path: [...here.path, tok] });
        queue.push(n);
      }
    }
  }
  return [...landings.values()];
}

/** Meilleure note possible pour une pièce posée n'importe où (sans se soucier du trajet) : sert à anticiper la suivante. */
function bestDrop(grid, type) {
  let best = -Infinity;
  for (let rot = 0; rot < 4; rot++) {
    for (let x = -2; x < C.COLS; x++) {
      if (collides(grid, type, rot, x, 0)) continue;
      const y = dropY(grid, type, rot, x, 0);
      const { grid: g, cleared } = place(grid, type, rot, x, y);
      best = Math.max(best, evaluate(g, cleared));
    }
  }
  return best;
}

export function createAI(level = 'normal', seed = 1) {
  const cfg = LEVELS[level] ?? LEVELS.normal;
  const rand = seeded(seed);
  let lastId = -1;
  let plan = [];
  let wait = 0;

  function candidates(b, type) {
    const out = [];
    for (const p of reachable(b.grid, type)) {
      const { grid, cleared } = place(b.grid, type, p.rot, p.x, p.y);
      let score = evaluate(grid, cleared);
      if (cfg.look) {
        const next = b.queue[0];
        if (next !== undefined) score += 0.7 * bestDrop(grid, next);
      }
      out.push({ ...p, score });
    }
    return out;
  }

  function makePlan(b) {
    const options = candidates(b, b.piece.type).map((c) => ({ ...c, hold: false }));
    if (cfg.hold && b.canHold) {
      const other = b.hold >= 0 ? b.hold : b.queue[0];
      if (other !== undefined && other !== b.piece.type) for (const c of candidates(b, other)) options.push({ ...c, hold: true, path: ['hold'] });
    }
    if (options.length === 0) return ['hd'];
    options.sort((a, c) => c.score - a.score);
    const pick = rand() < cfg.mistake ? options[Math.floor(rand() * Math.min(5, options.length))] : options[0];
    return pick.path;
  }

  return {
    level,
    /** L'entrée de cette image : { l, r, d, a }. */
    decide(b) {
      if (!b.piece) return {};
      if (b.pieceId !== lastId) {
        lastId = b.pieceId;
        plan = makePlan(b);
        wait = cfg.think;
      }
      if (wait > 0) {
        wait--;
        return {};
      }
      const tok = plan.shift() ?? 'hd';
      wait = cfg.delay - 1;
      switch (tok) {
        case 'L': return { l: true };
        case 'R': return { r: true };
        case 'cw': return { a: ['cw'] };
        case 'ccw': return { a: ['ccw'] };
        case 'hold': return { a: ['hold'] };
        default: return { a: ['hd'] };
      }
    },
  };
}
