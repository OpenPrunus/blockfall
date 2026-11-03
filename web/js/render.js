// Blockfall — rendu sur canvas : grille, pièces biseautées, fantôme, réserve, pièces à venir, jauge des lignes reçues, effets.
// Deux dispositions : « wide » (écran large : deux plateaux côte à côte en duel) et « tall » (téléphone debout : son plateau en grand,
// celui de l'adversaire en petit en haut).
import { C, SHAPES, collides, dropY } from './engine.js';

export const COLORS = ['#19d3f3', '#f7d308', '#b04cd9', '#3fd66b', '#f2494f', '#3b6cf0', '#f59a23', '#8b94a8'];

function mix(hex, to, k) {
  const n = parseInt(hex.slice(1), 16);
  const t = parseInt(to.slice(1), 16);
  const ch = (s) => Math.round(((n >> s) & 255) * (1 - k) + ((t >> s) & 255) * k);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}
const PALETTE = COLORS.map((c) => ({ base: c, light: mix(c, '#ffffff', 0.45), dark: mix(c, '#000000', 0.45) }));

/** Grille 22 × 10 reconstruite depuis le texte des 20 rangées visibles (les deux du haut, cachées, sont vides). */
const gridCache = new Map();
export function gridFromString(g) {
  let grid = gridCache.get(g);
  if (!grid) {
    grid = Array.from({ length: C.ROWS }, () => new Array(C.COLS).fill(0));
    for (let i = 0; i < g.length; i++) grid[C.HIDDEN + Math.floor(i / C.COLS)][i % C.COLS] = Number(g[i]);
    if (gridCache.size > 8) gridCache.clear();
    gridCache.set(g, grid);
  }
  return grid;
}

function cell(ctx, x, y, c, type, alpha = 1) {
  const p = PALETTE[type];
  ctx.globalAlpha = alpha;
  ctx.fillStyle = p.base;
  ctx.fillRect(x, y, c, c);
  ctx.fillStyle = p.light;
  ctx.fillRect(x, y, c, Math.max(2, c * 0.14));
  ctx.fillRect(x, y, Math.max(2, c * 0.14), c);
  ctx.fillStyle = p.dark;
  ctx.fillRect(x, y + c - Math.max(2, c * 0.14), c, Math.max(2, c * 0.14));
  ctx.fillRect(x + c - Math.max(2, c * 0.14), y, Math.max(2, c * 0.14), c);
  ctx.globalAlpha = 1;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.fx = [];
    this.pops = [];
    this.shake = [0, 0];
    this.kind = 'wide';
    this.versus = false;
    this.labels = {};
    this.setLayout('wide', false);
  }

  /** Disposition : 'wide' ou 'tall', solo ou duel. Fixe la taille logique du canvas. */
  setLayout(kind, versus) {
    this.kind = kind;
    this.versus = versus;
    let w; let h;
    if (kind === 'wide') {
      const c = versus ? 24 : 28;
      this.c = c;
      this.mini = null;
      if (versus) { w = 1020; h = 640; this.units = [{ ox: 20, oy: 64, c }, { ox: 520, oy: 64, c }]; } else { w = 720; h = 668; this.units = [{ ox: 80, oy: 54, c }]; }
    } else {
      const c = 22;
      if (versus) { w = 480; h = 700; this.units = [{ ox: 20, oy: 206, c }]; this.mini = { ox: 372, oy: 8, c: 9 }; } else { w = 480; h = 548; this.units = [{ ox: 20, oy: 54, c }]; this.mini = null; }
    }
    this.canvas.width = w;
    this.canvas.height = h;
    this.w = w;
    this.h = h;
  }

  /** Un événement du moteur : effets (éclair des lignes, texte, secousse) pour le plateau `u` (0 = le mien). */
  event(u, e) {
    const now = performance.now();
    if (e.t === 'clear') {
      this.fx.push({ u, rows: e.rows, t0: now });
      const label = this.labels[['', 'single', 'double', 'triple', 'tetris'][e.n]];
      if (label) this.pops.push({ u, text: label, t0: now, big: e.n === 4 });
    } else if (e.t === 'garbage') {
      this.shake[u] = now;
    }
  }

  draw(frame) {
    const ctx = this.ctx;
    const now = frame.time ?? performance.now();
    ctx.clearRect(0, 0, this.w, this.h);
    this.labels = frame.labels ?? this.labels;
    frame.views.slice(0, this.units.length).forEach((view, i) => {
      const u = this.units[i];
      const s = this.shake[i] && now - this.shake[i] < 260 ? Math.sin((now - this.shake[i]) / 18) * 5 * (1 - (now - this.shake[i]) / 260) : 0;
      ctx.save();
      ctx.translate(s, 0);
      this.unit(ctx, view, u.ox, u.oy, u.c, i, now);
      ctx.restore();
    });
    if (this.mini && frame.views[1]) this.miniBoard(ctx, frame.views[1], this.mini);
    this.fx = this.fx.filter((f) => now - f.t0 < 420);
    this.pops = this.pops.filter((p) => now - p.t0 < 1000);
    if (frame.overlay) this.overlay(ctx, frame.overlay);
  }

  panel(ctx, x, y, w, h) {
    ctx.fillStyle = 'rgba(20, 28, 54, 0.9)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 8);
    ctx.fill();
    ctx.stroke();
  }

  text(ctx, s, x, y, size, color = '#dbe4ff', align = 'left', weight = 600) {
    ctx.font = `${weight} ${size}px ui-sans-serif, system-ui, 'Segoe UI', Roboto, sans-serif`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(s, x, y);
  }

  /** Pièce centrée dans une boîte (réserve, pièces à venir). */
  preview(ctx, type, bx, by, bw, bh, c, alpha = 1) {
    if (type === undefined || type < 0) return;
    const cells = SHAPES[type][0];
    const xs = cells.map((p) => p[0]);
    const ys = cells.map((p) => p[1]);
    const w = Math.max(...xs) - Math.min(...xs) + 1;
    const h = Math.max(...ys) - Math.min(...ys) + 1;
    const ox = bx + (bw - w * c) / 2 - Math.min(...xs) * c;
    const oy = by + (bh - h * c) / 2 - Math.min(...ys) * c;
    for (const [cx, cy] of cells) cell(ctx, ox + cx * c, oy + cy * c, c, type, alpha);
  }

  unit(ctx, v, ox, oy, c, idx, now) {
    const bx = ox + 5 * c;
    const pw = 4.5 * c;
    const L = this.labels;
    // nom du joueur
    this.text(ctx, v.name ?? '', bx + 5 * c, oy - 12, Math.round(c * 0.8), '#eef2ff', 'center', 700);
    // réserve
    this.panel(ctx, ox, oy, pw, 3.4 * c);
    this.text(ctx, L.hold ?? 'HOLD', ox + pw / 2, oy + 0.95 * c, c * 0.5, '#8fa0d6', 'center', 700);
    this.preview(ctx, v.hold, ox, oy + 1.1 * c, pw, 2.3 * c, c * 0.62, v.canHold ? 1 : 0.35);
    // statistiques
    const sy = oy + 4.2 * c;
    this.panel(ctx, ox, sy, pw, 7.2 * c);
    [[L.score ?? 'SCORE', String(v.score ?? 0)], [L.lines ?? 'LINES', String(v.lines ?? 0)], [L.level ?? 'LEVEL', String(v.level ?? 1)]].forEach(([k, val], i) => {
      this.text(ctx, k, ox + pw / 2, sy + (1.15 + i * 2.35) * c, c * 0.46, '#8fa0d6', 'center', 700);
      this.text(ctx, val, ox + pw / 2, sy + (2.2 + i * 2.35) * c, c * 0.85, '#ffffff', 'center', 800);
    });
    // plateau
    ctx.fillStyle = '#0a0f21';
    ctx.fillRect(bx, oy, 10 * c, 20 * c);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 10; i++) { ctx.moveTo(bx + i * c, oy); ctx.lineTo(bx + i * c, oy + 20 * c); }
    for (let j = 1; j < 20; j++) { ctx.moveTo(bx, oy + j * c); ctx.lineTo(bx + 10 * c, oy + j * c); }
    ctx.stroke();
    const g = v.g ?? '0'.repeat(200);
    for (let i = 0; i < 200; i++) {
      const t = g.charCodeAt(i) - 49;
      if (t >= 0) cell(ctx, bx + (i % 10) * c, oy + Math.floor(i / 10) * c, c, t);
    }
    if (v.p && v.al !== false) {
      const [type, rot, px, py] = v.p;
      const grid = gridFromString(g);
      const gy = dropY(grid, type, rot, px, py);
      for (const [cx, cy] of SHAPES[type][rot]) {
        const y = gy + cy - C.HIDDEN;
        if (y >= 0 && gy !== py) {
          ctx.strokeStyle = PALETTE[type].base;
          ctx.globalAlpha = 0.55;
          ctx.lineWidth = 2;
          ctx.strokeRect(bx + (px + cx) * c + 1, oy + y * c + 1, c - 2, c - 2);
          ctx.globalAlpha = 1;
        }
      }
      for (const [cx, cy] of SHAPES[type][rot]) {
        const y = py + cy - C.HIDDEN;
        if (y >= 0) cell(ctx, bx + (px + cx) * c, oy + y * c, c, type);
      }
    }
    // éclair des lignes effacées
    for (const f of this.fx) {
      if (f.u !== idx) continue;
      const k = 1 - (now - f.t0) / 420;
      ctx.fillStyle = `rgba(255,255,255,${Math.max(0, k) * 0.85})`;
      for (const r of f.rows) if (r >= C.HIDDEN) ctx.fillRect(bx, oy + (r - C.HIDDEN) * c, 10 * c, c);
    }
    // jauge des lignes reçues (à gauche du plateau)
    const pg = Math.min(20, v.pending ?? 0);
    if (pg > 0) {
      ctx.fillStyle = '#ff4d5e';
      ctx.fillRect(bx - 0.4 * c, oy + (20 - pg) * c, 0.3 * c, pg * c);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 2;
    ctx.strokeRect(bx - 1, oy - 1, 10 * c + 2, 20 * c + 2);
    // pièces à venir
    const nx = bx + 10 * c + 0.5 * c;
    this.panel(ctx, nx, oy, pw, 13.6 * c);
    this.text(ctx, L.next ?? 'NEXT', nx + pw / 2, oy + 0.95 * c, c * 0.5, '#8fa0d6', 'center', 700);
    (v.queue ?? []).slice(0, 5).forEach((type, i) => this.preview(ctx, type, nx, oy + (1.3 + i * 2.5) * c, pw, 2.3 * c, c * (i === 0 ? 0.62 : 0.5)));
    // textes qui montent
    for (const p of this.pops) {
      if (p.u !== idx) continue;
      const k = (now - p.t0) / 1000;
      ctx.globalAlpha = Math.max(0, 1 - k * k);
      this.text(ctx, p.text, bx + 5 * c, oy + 8 * c - k * 3 * c, c * (p.big ? 1.5 : 1.1), p.big ? '#ffe066' : '#ffffff', 'center', 800);
      ctx.globalAlpha = 1;
    }
    if (v.al === false) {
      ctx.fillStyle = 'rgba(8, 10, 22, 0.62)';
      ctx.fillRect(bx, oy, 10 * c, 20 * c);
    }
  }

  /** Plateau de l'adversaire en petit (disposition « tall ») : sa pile, ses lignes à recevoir et son nom. */
  miniBoard(ctx, v, m) {
    const { ox, oy, c } = m;
    this.text(ctx, v.name ?? '', ox - 14, oy + 14, 15, '#eef2ff', 'right', 700);
    this.text(ctx, `${v.lines ?? 0} ${this.labels.lines ?? 'LINES'}`, ox - 14, oy + 36, 13, '#8fa0d6', 'right', 600);
    ctx.fillStyle = '#0a0f21';
    ctx.fillRect(ox, oy, 10 * c, 20 * c);
    const g = v.g ?? '0'.repeat(200);
    for (let i = 0; i < 200; i++) {
      const t = g.charCodeAt(i) - 49;
      if (t >= 0) { ctx.fillStyle = PALETTE[t].base; ctx.fillRect(ox + (i % 10) * c, oy + Math.floor(i / 10) * c, c - 1, c - 1); }
    }
    if (v.p && v.al !== false) for (const [cx, cy] of SHAPES[v.p[0]][v.p[1]]) {
      const y = v.p[3] + cy - C.HIDDEN;
      if (y >= 0) { ctx.fillStyle = PALETTE[v.p[0]].base; ctx.fillRect(ox + (v.p[2] + cx) * c, oy + y * c, c - 1, c - 1); }
    }
    const pg = Math.min(20, v.pending ?? 0);
    if (pg > 0) { ctx.fillStyle = '#ff4d5e'; ctx.fillRect(ox - 6, oy + (20 - pg) * c, 4, pg * c); }
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.strokeRect(ox - 1, oy - 1, 10 * c + 2, 20 * c + 2);
    if (v.al === false) { ctx.fillStyle = 'rgba(8,10,22,0.6)'; ctx.fillRect(ox, oy, 10 * c, 20 * c); }
  }

  overlay(ctx, o) {
    ctx.fillStyle = 'rgba(6, 9, 20, 0.5)';
    ctx.fillRect(0, 0, this.w, this.h);
    this.text(ctx, o.text, this.w / 2, this.h / 2 + 26, o.size ?? 120, '#ffffff', 'center', 800);
    if (o.sub) this.text(ctx, o.sub, this.w / 2, this.h / 2 + 70, 24, '#b9c6f5', 'center', 600);
  }
}
