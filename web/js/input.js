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

  /** Branche les boutons tactiles (`data-k` : left, right, down, cw, ccw, hd, hold). */
  bindTouch(root) {
    for (const btn of root.querySelectorAll('button[data-k]')) {
      const name = btn.dataset.k;
      btn.addEventListener('pointerdown', (e) => {
        if (!this.enabled) return;
        btn.setPointerCapture(e.pointerId);
        btn.classList.add('down');
        this.press(name);
        e.preventDefault();
      });
      for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        btn.addEventListener(ev, () => {
          btn.classList.remove('down');
          this.release(name);
        });
      }
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    }
  }
}
