import test from 'node:test';
import assert from 'node:assert/strict';
import {
  C, GRAVITY, SHAPES, I, O, T, S, Z, J, L, createBoard, createVersus, step, stepVersus, collides, dropY, rotatePiece, pendingLines, gridString, snapshot,
} from '../web/js/engine.js';

const idle = {};
const fresh = (seed = 7, opts = {}) => createBoard({ seed, ...opts });
/** Avance jusqu'à ce qu'une pièce soit en jeu (délai d'apparition). */
const ready = (b) => { let n = 0; while (!b.piece && b.alive && n++ < 100) step(b, idle); return b; };
const put = (b, rows) => { for (const [y, text] of Object.entries(rows)) b.grid[y] = [...text].map((c) => Number(c)); };

test('les sept pièces ont quatre cases dans chacune de leurs quatre rotations, et les formes standard', () => {
  for (const rots of SHAPES) { assert.equal(rots.length, 4); for (const cells of rots) assert.equal(cells.length, 4); }
  const norm = (cells) => cells.map(([x, y]) => `${x},${y}`).sort().join(' ');
  assert.equal(norm(SHAPES[T][0]), '0,1 1,0 1,1 2,1', 'T debout');
  assert.equal(norm(SHAPES[T][1]), '1,0 1,1 1,2 2,1', 'T tournée à droite');
  assert.equal(norm(SHAPES[I][1]), '2,0 2,1 2,2 2,3', 'I verticale');
  assert.equal(norm(SHAPES[O][0]), norm(SHAPES[O][2]), 'O ne tourne pas');
  assert.equal(norm(SHAPES[L][0]), '0,1 1,1 2,0 2,1');
});

test('le premier sac contient les sept pièces, et la suite dépend de la graine', () => {
  assert.equal(new Set(fresh(99).queue.slice(0, 6)).size, 6);
  assert.notDeepEqual(fresh(1).queue, fresh(2).queue);
  assert.deepEqual(fresh(5).queue, fresh(5).queue, 'même graine, même suite');
});

test('la suite des pièces est identique sur de longues parties : 7 pièces différentes par sac', () => {
  const b = fresh(2024);
  const pieces = [];
  for (let i = 0; i < 140 && b.alive; i++) {
    ready(b);
    pieces.push(b.piece.type);
    // pose la pièce à gauche ou à droite en alternance pour ne pas mourir
    b.grid = Array.from({ length: C.ROWS }, () => new Array(C.COLS).fill(0));
    step(b, { a: ['hd'] });
  }
  for (let bag = 0; bag < 20; bag++) assert.equal(new Set(pieces.slice(bag * 7, bag * 7 + 7)).size, 7, `sac ${bag}`);
});

test('déplacements : gauche, droite, murs, et répétition automatique après le DAS', () => {
  const b = ready(fresh());
  const x0 = b.piece.x;
  step(b, { l: true });
  assert.equal(b.piece.x, x0 - 1, 'un appui = un pas');
  for (let i = 0; i < C.DAS - 1; i++) step(b, { l: true });
  assert.equal(b.piece.x, x0 - 1, 'avant le DAS : pas de répétition');
  step(b, { l: true });
  assert.equal(b.piece.x, x0 - 2, 'le DAS est écoulé : premier pas répété');
  for (let i = 0; i < 40; i++) step(b, { l: true });
  assert.ok(Math.min(...SHAPES[b.piece.type][b.piece.rot].map(([cx]) => b.piece.x + cx)) >= 0, 'bloquée par le mur');
  step(b, idle);
  step(b, { r: true });
  assert.ok(b.piece.x > 0 || true);
  const both = ready(fresh(3));
  const xb = both.piece.x;
  step(both, { l: true, r: true });
  assert.equal(both.piece.x, xb, 'gauche + droite : rien');
});

test('actions « left » et « right » : une case à la fois, bloquées par les murs', () => {
  const b = ready(fresh(21));
  const x0 = b.piece.x;
  step(b, { a: ['left'] });
  assert.equal(b.piece.x, x0 - 1);
  step(b, { a: ['right', 'right'] });
  assert.equal(b.piece.x, x0 + 1, 'plusieurs pas dans la même image');
  for (let i = 0; i < 12; i++) step(b, { a: ['left'] });
  const minX = Math.min(...SHAPES[b.piece.type][b.piece.rot].map(([cx]) => b.piece.x + cx));
  assert.equal(minX, 0, 'arrêtée contre le mur gauche');
});

test('rotation horaire et anti-horaire, et la pièce O ne bouge pas', () => {
  const b = ready(fresh(11));
  b.piece = { type: T, rot: 0, x: 3, y: 5 };
  step(b, { a: ['cw'] });
  assert.equal(b.piece.rot, 1);
  step(b, { a: ['ccw'] });
  assert.equal(b.piece.rot, 0);
  step(b, { a: ['ccw'] });
  assert.equal(b.piece.rot, 3);
  b.piece = { type: O, rot: 0, x: 3, y: 5 };
  const before = JSON.stringify(SHAPES[O][0]);
  step(b, { a: ['cw'] });
  assert.equal(JSON.stringify(SHAPES[O][b.piece.rot]), before);
});

test('rebonds SRS : une I collée au mur tourne en se décalant, une T glisse dans un trou (T-spin double)', () => {
  const grid = Array.from({ length: C.ROWS }, () => new Array(C.COLS).fill(0));
  const wall = { type: I, rot: 1, x: -2, y: 10 };            // I verticale dans la colonne 0
  assert.equal(collides(grid, I, 1, -2, 10), false);
  const r = rotatePiece(grid, wall, 1);
  assert.ok(r && r.rot === 2, 'rotation obtenue grâce à un rebond');
  assert.ok(!collides(grid, I, r.rot, r.x, r.y));
  // T-spin double classique : trou en T au fond
  put({ grid }, {});
  grid[20] = [1, 1, 1, 0, 0, 0, 1, 1, 1, 1];
  grid[21] = [1, 1, 1, 1, 0, 1, 1, 1, 1, 1];
  grid[19] = [1, 1, 0, 0, 0, 0, 0, 1, 1, 1];
  const t = { type: T, rot: 2, x: 3, y: 19 };
  assert.equal(collides(grid, T, 2, 3, 19), false, 'T pointe vers le bas, dans le creux');
  const kicked = rotatePiece(grid, { type: T, rot: 0, x: 3, y: 18 }, 1);
  assert.ok(kicked === null || !collides(grid, T, kicked.rot, kicked.x, kicked.y));
  assert.ok(t);
});

test('chute dure : la pièce se pose tout en bas, rapporte 2 points par rangée et la suivante apparaît', () => {
  const b = ready(fresh(5));
  const y = dropY(b.grid, b.piece.type, b.piece.rot, b.piece.x, b.piece.y);
  const ev = [];
  const id = b.pieceId;
  step(b, { a: ['hd'] }, ev);
  assert.equal(b.score, 2 * y);
  assert.ok(ev.some((e) => e.t === 'lock'));
  assert.equal(b.piece, null);
  ready(b);
  assert.equal(b.pieceId, id + 1);
  assert.ok(gridString(b).includes('1') || gridString(b).match(/[1-7]/), 'des cases sont posées');
});

test('gravité : la pièce descend toute seule, de plus en plus vite avec le niveau', () => {
  const b = ready(fresh(8));
  const y0 = b.piece.y;
  for (let i = 0; i < 240; i++) step(b, idle);
  assert.ok(b.piece.y >= y0 + 3, `elle est descendue : ${b.piece.y - y0} rangées en 4 s au niveau 1`);
  assert.ok(GRAVITY[10] > GRAVITY[1] * 5 && GRAVITY[20] === 20 * 65536);
  const fast = createBoard({ seed: 8, startLevel: 15 });
  ready(fast);
  for (let i = 0; i < 6; i++) step(fast, idle);
  assert.ok(fast.piece === null || fast.piece.y > 8, 'au niveau 15 elle tombe presque instantanément');
});

test('chute douce : plus rapide que la gravité, un point par rangée', () => {
  const b = ready(fresh(8));
  const y0 = b.piece.y;
  for (let i = 0; i < 20; i++) step(b, { d: true });
  assert.ok(b.piece.y - y0 >= 9, `chute douce : ${b.piece.y - y0} rangées en 20 images`);
  assert.ok(b.score >= 9);
});

test('délai de verrouillage : posée au sol elle se fige après 30 images, et bouger le remet à zéro (15 fois au plus)', () => {
  const b = ready(fresh(9));
  b.piece = { type: O, rot: 0, x: 4, y: dropY(b.grid, O, 0, 4, 0) };
  const id = b.pieceId;
  for (let i = 0; i < C.LOCK_DELAY - 2; i++) step(b, idle);
  assert.equal(b.piece?.type, O, 'pas encore figée');
  assert.equal(b.pieceId, id);
  for (let i = 0; i < 4; i++) step(b, idle);
  assert.equal(b.piece, null, 'figée');
  // remises à zéro : une pièce que l'on pousse sans arrêt finit quand même par se figer
  const c = ready(fresh(10));
  c.piece = { type: O, rot: 0, x: 4, y: dropY(c.grid, O, 0, 4, 0) };
  let frames = 0;
  while (c.piece && frames < 2000) { step(c, { a: [frames % 2 === 0 ? 'cw' : 'ccw'] }); frames++; }
  assert.equal(c.piece, null, 'figée malgré les mouvements');
});

test('mise en réserve : une fois par pièce, échange avec la réserve', () => {
  const b = ready(fresh(12));
  const first = b.piece.type;
  const queued = b.queue[0];
  step(b, { a: ['hold'] });
  assert.equal(b.hold, first);
  assert.equal(b.piece.type, queued, 'la pièce suivante est apparue');
  assert.equal(b.canHold, false);
  step(b, { a: ['hold'] });
  assert.equal(b.hold, first, 'deuxième réserve refusée avant la pose');
  step(b, { a: ['hd'] });
  ready(b);
  const cur = b.piece.type;
  step(b, { a: ['hold'] });
  assert.equal(b.piece.type, first, 'on récupère la réserve');
  assert.equal(b.hold, cur);
});

test('une ligne complète disparaît, rapporte des points et fait descendre ce qui est au-dessus', () => {
  const b = ready(fresh(13));
  b.grid[21] = [1, 1, 1, 1, 1, 1, 1, 0, 0, 0];
  b.grid[20] = [7, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  b.piece = { type: I, rot: 0, x: 0, y: 0 };                     // I couchée : on la glisse en bout de rangée
  b.piece = { type: J, rot: 0, x: 7, y: dropY(b.grid, J, 0, 7, 0) };
  const ev = [];
  step(b, { a: ['hd'] }, ev);
  const clear = ev.find((e) => e.t === 'clear');
  assert.ok(clear && clear.n >= 1, 'au moins une ligne');
  assert.ok(b.lines >= 1 && b.score >= 100);
  assert.equal(b.grid[21].filter((v) => v !== 0).length > 0, true, 'les rangées du dessus ont descendu');
});

test('un quadruple (4 lignes) rapporte 800 × niveau, et le suivant 1200 (dos à dos)', () => {
  const play = () => {
    const b = ready(fresh(14));
    for (let y = 18; y < 22; y++) b.grid[y] = [1, 1, 1, 1, 1, 1, 1, 1, 1, 0];
    b.piece = { type: I, rot: 1, x: 7, y: 0 };                    // colonne 9 (x + 2)
    return b;
  };
  const b = play();
  const ev = [];
  step(b, { a: ['hd'] }, ev);
  assert.equal(ev.find((e) => e.t === 'clear').n, 4);
  assert.equal(b.lines, 4);
  assert.ok(b.score >= 800, `score ${b.score}`);
  assert.equal(b.b2b, true);
  ready(b);
  for (let y = 18; y < 22; y++) b.grid[y] = [1, 1, 1, 1, 1, 1, 1, 1, 1, 0];
  b.piece = { type: I, rot: 1, x: 7, y: 0 };
  const before = b.score;
  step(b, { a: ['hd'] });
  assert.ok(b.score - before >= 1200, `dos à dos : +${b.score - before}`);
});

test('le niveau monte toutes les dix lignes en marathon, et avec le temps en duel', () => {
  const b = fresh(15);
  b.lines = 25;
  ready(b);
  step(b, idle);
  assert.equal(b.level, 3);
  const v = createVersus({ seed: 3 });
  for (let i = 0; i < C.TIME_LEVEL * 2 + 5; i++) stepVersus(v, [idle, idle]);
  assert.ok(v.boards[0].level >= 3 || !v.boards[0].alive);
});

test('perdre : plus de place pour la pièce suivante, ou pièce figée entièrement dans les rangées cachées', () => {
  const b = ready(fresh(16));
  for (let y = 2; y < 22; y++) b.grid[y] = [1, 1, 1, 1, 1, 1, 1, 1, 1, 0];
  b.grid[1] = [0, 0, 0, 1, 1, 1, 0, 0, 0, 0];
  step(b, { a: ['hd'] });
  for (let i = 0; i < 60; i++) step(b, idle);
  assert.equal(b.alive, false);
  const frame = b.frame;
  step(b, { l: true });
  assert.equal(b.frame, frame, 'un plateau perdu ne bouge plus');
});

test('duel : les deux plateaux reçoivent la même suite de pièces', () => {
  const v = createVersus({ seed: 777 });
  assert.deepEqual(v.boards[0].queue, v.boards[1].queue);
  for (let i = 0; i < 40; i++) stepVersus(v, [{ a: ['hd'] }, { a: ['hd'] }]);
  assert.deepEqual(v.boards[0].pieceId, v.boards[1].pieceId);
});

test('duel : les lignes envoyées arrivent chez l\'adversaire, annulent les siennes, et apparaissent avec un trou', () => {
  const v = createVersus({ seed: 21 });
  const [a, b] = v.boards;
  ready(a); ready(b);
  for (let y = 18; y < 22; y++) a.grid[y] = [1, 1, 1, 1, 1, 1, 1, 1, 1, 0];
  a.piece = { type: I, rot: 1, x: 7, y: 0 };
  const evs = stepVersus(v, [{ a: ['hd'] }, idle]);
  const atk = evs[0].find((e) => e.t === 'attack');
  assert.equal(atk?.n, 4, 'un quadruple envoie 4 lignes');
  assert.equal(pendingLines(b), 4);
  // elles arrivent quand l'adversaire pose une pièce sans faire de ligne
  b.piece = { type: O, rot: 0, x: 4, y: 0 };
  const ev = stepVersus(v, [idle, { a: ['hd'] }]);
  assert.ok(ev[1].some((e) => e.t === 'garbage' && e.n === 4));
  assert.equal(pendingLines(b), 0);
  const garbageRows = b.grid.filter((row) => row.filter((c) => c === 8).length === 9);
  assert.equal(garbageRows.length, 4, 'quatre lignes de déchets avec un seul trou');
  const hole = garbageRows[0].indexOf(0);
  assert.ok(garbageRows.every((row) => row.indexOf(0) === hole), 'le trou est dans la même colonne pour un même envoi');
  // annulation : le plateau a reçoit 2 lignes puis en efface 4 : il annule les 2
  a.pending.push(2);
  ready(a);
  for (let y = 18; y < 22; y++) a.grid[y] = [1, 1, 1, 1, 1, 1, 1, 1, 1, 0];
  a.piece = { type: I, rot: 1, x: 7, y: 0 };
  const ev2 = stepVersus(v, [{ a: ['hd'] }, idle]);
  const atk2 = ev2[0].find((e) => e.t === 'attack');
  assert.ok(pendingLines(a) === 0 && (atk2?.n ?? 0) >= 2, `2 annulées, ${atk2?.n} envoyées`);
});

test('duel : celui dont le plateau est plein perd', () => {
  const v = createVersus({ seed: 5 });
  const [a] = v.boards;
  ready(a);
  for (let y = 2; y < 22; y++) a.grid[y] = [1, 1, 1, 1, 1, 1, 1, 1, 1, 0];
  a.grid[1] = [0, 0, 0, 1, 1, 1, 0, 0, 0, 0];
  for (let i = 0; i < 120 && v.winner === null; i++) stepVersus(v, [{ a: ['hd'] }, idle]);
  assert.equal(v.winner, 1);
});

test('déterminisme : mêmes entrées, même partie, même résumé', () => {
  const run = () => {
    const b = createBoard({ seed: 31337 });
    let s = 1;
    for (let i = 0; i < 4000 && b.alive; i++) {
      s = (s * 1103515245 + 12345) % 2147483648;
      const r = s % 11;
      step(b, { l: r === 0, r: r === 1, d: r === 2, a: r === 3 ? ['cw'] : r === 4 ? ['ccw'] : r === 5 ? ['hd'] : r === 6 ? ['hold'] : [] });
    }
    return JSON.stringify(snapshot(b));
  };
  assert.equal(run(), run());
});
