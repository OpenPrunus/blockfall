// Blockfall — entrées : clavier et boutons tactiles. Un « contrôleur » garde les touches tenues et les actions pressées ;
// le jeu local le lit à chaque image, le mode en ligne en envoie les changements au serveur.

const KEYS = {
  left: ['ArrowLeft', 'a', 'q'],
  right: ['ArrowRight', 'd'],
  down: ['ArrowDown', 's'],
  hd: [' '],
  cw: ['ArrowUp', 'x', 'w'],
  ccw: ['z', 'Control'],
  hold: ['c', 'Shift', 'h'],
};

const normKey = (e) => (e.key.length === 1 ? e.key.toLowerCase() : e.key);

export class Controller {
  /** @param {{onKeys?: (held: object) => void, onAction?: (a: string) => void}} handlers */
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.held = { l: false, r: false, d: false };
    this.pulse = { l: false, r: false, d: false };       // appuyée puis relâchée entre deux images : elle compte quand même une fois
    this.actions = [];
    this.enabled = false;
    this.codes = new Set();
    window.addEventListener('keydown', (e) => this.down(e));
    window.addEventListener('keyup', (e) => this.up(e));
    window.addEventListener('blur', () => this.releaseAll());
  }

  /** Active ou coupe les entrées (en jeu seulement : les menus gardent leur clavier). */
  setEnabled(on) {
    this.enabled = on;
    if (!on) this.releaseAll();
  }

  which(e) {
    const k = normKey(e);
    return Object.entries(KEYS).find(([, list]) => list.includes(k))?.[0] ?? null;
  }

  down(e) {
    if (!this.enabled || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const name = this.which(e);
    if (!name) return;
    e.preventDefault();
    if (e.repeat) return;
    this.press(name);
  }

  up(e) {
    const name = this.which(e);
    if (name) this.release(name);
  }

  /** Une touche ou un bouton est pressé : `name` parmi left, right, down (tenues) et hd, cw, ccw, hold (actions). */
  press(name) {
    if (name === 'left') this.setHeld('l', true);
    else if (name === 'right') this.setHeld('r', true);
    else if (name === 'down') this.setHeld('d', true);
    else {
      this.actions.push(name);
      this.handlers.onAction?.(name);
    }
  }

  release(name) {
    if (name === 'left') this.setHeld('l', false);
    else if (name === 'right') this.setHeld('r', false);
    else if (name === 'down') this.setHeld('d', false);
  }

  setHeld(k, v) {
    if (this.held[k] === v) return;
    this.held[k] = v;
    if (v) this.pulse[k] = true;
    this.handlers.onKeys?.({ ...this.held });
  }

  releaseAll() {
    for (const k of ['l', 'r', 'd']) this.setHeld(k, false);
  }

  /** L'entrée de cette image pour le moteur local : touches tenues et actions pressées depuis la dernière lecture. */
  poll() {
    const a = this.actions;
    this.actions = [];
    const input = { l: this.held.l || this.pulse.l, r: this.held.r || this.pulse.r, d: this.held.d || this.pulse.d, a };
    this.pulse = { l: false, r: false, d: false };
    return input;
  }

  /** Un pas de côté (une case), envoyé comme une action : fiable même si plusieurs arrivent dans la même image. */
  stepSide(dir) {
    const name = dir < 0 ? 'left' : 'right';
    this.actions.push(name);
    this.handlers.onAction?.(name);
  }

  /**
   * Commandes tactiles par gestes sur `target` : glisser à gauche ou à droite déplace la pièce d'une case par case parcourue,
   * glisser vers le haut ou toucher la tourne, glisser vers le bas la pose d'un coup, un appui long la met en réserve.
   * `cellPx()` donne la taille d'une case à l'écran (en pixels CSS).
   */
  bindGestures(target, cellPx) {
    const TAP_MS = 260;
    const TAP_PX = 14;
    const SWIPE_PX = 46;
    const LONG_MS = 420;
    let g = null;
    const end = () => {
      if (g) clearTimeout(g.long);
      g = null;
    };
    target.addEventListener('pointerdown', (e) => {
      if (!this.enabled || e.pointerType === 'mouse' || g) return;
      if (e.target instanceof Element && e.target.closest('button, a, input, select, .panel')) return;
      g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, t0: performance.now(), moved: false, done: false, horizontal: false, long: null };
      g.long = setTimeout(() => {
        if (g && !g.moved && !g.done) {
          g.done = true;
          this.press('hold');
        }
      }, LONG_MS);
    });
    window.addEventListener('pointermove', (e) => {
      if (!g || e.pointerId !== g.id || !this.enabled) return;
      const dx = e.clientX - g.x0;
      const dy = e.clientY - g.y0;
      if (!g.moved && Math.hypot(dx, dy) > TAP_PX) {
        g.moved = true;
        clearTimeout(g.long);
      }
      if (g.done || !g.moved) return;
      if (!g.horizontal) {
        if (Math.abs(dy) >= SWIPE_PX && Math.abs(dy) > 1.6 * Math.abs(dx)) {          // geste vertical net : tourner ou poser
          g.done = true;
          this.press(dy < 0 ? 'cw' : 'hd');
          return;
        }
        if (Math.abs(dx) > Math.abs(dy)) g.horizontal = true;                          // geste horizontal : on suit le doigt
      }
      if (g.horizontal) {
        const c = Math.max(12, cellPx());
        while (Math.abs(e.clientX - g.x) >= c) {
          const dir = e.clientX > g.x ? 1 : -1;
          g.x += dir * c;
          this.stepSide(dir);
        }
      }
    });
    const up = (e) => {
      if (!g || e.pointerId !== g.id) return;
      if (!g.moved && !g.done && performance.now() - g.t0 < TAP_MS && this.enabled) this.press('cw');   // un simple toucher tourne
      end();
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', end);
  }
}
