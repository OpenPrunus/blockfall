import test from 'node:test';
import assert from 'node:assert/strict';
import { C, createBoard, createVersus, step, stepVersus, collides } from '../web/js/engine.js';
import { LEVELS, createAI, reachable, seeded } from '../web/js/ai.js';

const SECONDS = (n) => n * 60;

function marathon(level, seed, frames) {
  const b = createBoard({ seed, mode: 'marathon' });
  const ai = createAI(level, seed);
  for (let f = 0; f < frames && b.alive; f++) step(b, ai.decide(b));
  return b;
}

function duel(l0, l1, seed, frames = SECONDS(300)) {
  const v = createVersus({ seed });
  const ais = [createAI(l0, seed), createAI(l1, seed + 1)];
  for (let f = 0; f < frames && v.winner === null; f++) stepVersus(v, [ais[0].decide(v.boards[0]), ais[1].decide(v.boards[1])]);
  return v;
}

test('trois niveaux : de plus en plus rapide, de moins en moins d\'erreurs', () => {
  assert.deepEqual(Object.keys(LEVELS), ['easy', 'normal', 'hard']);
  assert.ok(LEVELS.hard.delay < LEVELS.normal.delay && LEVELS.normal.delay < LEVELS.easy.delay);
  assert.ok(LEVELS.hard.mistake < LEVELS.normal.mistake && LEVELS.normal.mistake < LEVELS.easy.mistake);
});

test('un plateau vide offre des positions atteignables pour chaque pièce, toutes sans collision', () => {
  const grid = Array.from({ length: C.ROWS }, () => new Array(C.COLS).fill(0));
  for (let type = 0; type < 7; type++) {
    const spots = reachable(grid, type);
    assert.ok(spots.length >= (type === 1 ? 9 : 17), `pièce ${type} : ${spots.length} positions`);
    for (const s of spots) {
      assert.ok(!collides(grid, type, s.rot, s.x, s.y), 'la position est libre');
      assert.ok(collides(grid, type, s.rot, s.x, s.y + 1), 'et la pièce repose sur quelque chose');
      assert.equal(s.path.at(-1), 'hd');
    }
  }
});

test('l\'ordinateur joue proprement : il efface des lignes et survit longtemps', () => {
  const b = marathon('hard', 5, SECONDS(90));
  assert.ok(b.alive);
  assert.ok(b.lines >= 40, `${b.lines} lignes en 90 s`);
  const easy = marathon('easy', 5, SECONDS(90));
  assert.ok(b.lines > easy.lines * 2, `difficile ${b.lines} lignes, facile ${easy.lines}`);
});

test('même graine, même partie', () => {
  const a = marathon('normal', 9, SECONDS(40));
  const b = marathon('normal', 9, SECONDS(40));
  assert.deepEqual([a.score, a.lines, a.pieceId], [b.score, b.lines, b.pieceId]);
  assert.notEqual(marathon('normal', 10, SECONDS(40)).score, a.score);
});

test('il utilise la réserve aux niveaux normal et difficile, pas au niveau facile', () => {
  const hold = (level) => {
    const b = createBoard({ seed: 77, mode: 'marathon' });
    const ai = createAI(level, 77);
    let held = false;
    for (let f = 0; f < SECONDS(30) && b.alive; f++) { step(b, ai.decide(b)); if (b.hold >= 0) held = true; }
    return held;
  };
  assert.equal(hold('easy'), false);
  assert.equal(hold('hard'), true);
});

test('en duel le niveau supérieur gagne presque toujours (12 duels)', () => {
  let wins = 0;
  let unfinished = 0;
  for (let i = 0; i < 12; i++) {
    const v = duel('hard', 'easy', 100 + i);
    if (v.winner === 0) wins++;
    if (v.winner === null) unfinished++;
  }
  assert.ok(wins >= 10, `difficile gagne ${wins}/12 contre facile`);
  assert.ok(unfinished <= 1);
  let normalWins = 0;
  for (let i = 0; i < 12; i++) if (duel('normal', 'easy', 200 + i).winner === 0) normalWins++;
  assert.ok(normalWins >= 9, `normal gagne ${normalWins}/12 contre facile`);
});

test('un duel finit toujours : la vitesse monte avec le temps', () => {
  const v = duel('hard', 'hard', 31, SECONDS(900));
  assert.notEqual(v.winner, null);
});

test('le générateur à graine est déterministe', () => {
  const a = seeded(3);
  const b = seeded(3);
  for (let i = 0; i < 10; i++) assert.equal(a(), b());
});
