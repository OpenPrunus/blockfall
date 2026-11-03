// Génère tests/fixtures/engine-vectors.json : des parties jouées par le moteur JS (entrées image par image, résumés réguliers).
// Les tests PHP (tests/php/Engine/FixturesTest.php) rejouent les mêmes entrées avec src/Engine et exigent les mêmes résumés.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBoard, createVersus, step, stepVersus, snapshot } from '../../web/js/engine.js';
import { createAI, seeded } from '../../web/js/ai.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHECK = 120;
const games = [];

const bitsOf = (i) => (i.l ? 1 : 0) | (i.r ? 2 : 0) | (i.d ? 4 : 0);

/** Entrée « chaos » : touches et actions au hasard (déplacements, rotations, chutes, réserve), pour exercer tous les cas. */
function chaos(rand) {
  let held = { l: false, r: false, d: false };
  return () => {
    if (rand() < 0.08) held = { l: rand() < 0.3, r: rand() < 0.3, d: rand() < 0.25 };
    const a = [];
    const x = rand();
    if (x < 0.05) a.push('cw'); else if (x < 0.09) a.push('ccw'); else if (x < 0.115) a.push('hd'); else if (x < 0.13) a.push('hold'); else if (x < 0.17) a.push('left'); else if (x < 0.21) a.push('right');
    return { ...held, a };
  };
}

function record({ name, kind, seed, frames, players, startLevel = 1 }) {
  const rand = seeded(seed * 7 + 1);
  const brains = players.map((p, i) => (p === 'chaos' ? chaos(seeded(seed * 13 + i)) : (() => { const ai = createAI(p, seed + i); return (b) => ai.decide(b); })()));
  const versus = kind === 'versus';
  const world = versus ? createVersus({ seed }) : null;
  const solo = versus ? null : createBoard({ seed, mode: 'marathon', startLevel });
  const boards = versus ? world.boards : [solo];
  const inputs = [];
  const last = boards.map(() => 0);
  const checks = [];
  let f = 0;
  const done = () => (versus ? world.winner !== null : !solo.alive);
  while (f < frames && !done()) {
    f++;
    const frameInputs = boards.map((b, i) => {
      const input = brains[i](b);
      const a = input.a ?? [];
      const bits = bitsOf(input);
      if (bits !== last[i] || a.length > 0) {
        inputs.push([f, i, bits, a.join(',')]);
        last[i] = bits;
      }
      return { l: !!input.l, r: !!input.r, d: !!input.d, a };
    });
    if (versus) stepVersus(world, frameInputs);
    else step(solo, frameInputs[0]);
    if (f % CHECK === 0) checks.push([f, boards.map(snapshot)]);
  }
  checks.push([f, boards.map(snapshot)]);
  games.push({ name, kind, seed, startLevel, frames: f, inputs, checks, winner: versus ? world.winner : null });
  void rand;
}

record({ name: 'duel difficile contre normal', kind: 'versus', seed: 11, frames: 3600, players: ['hard', 'normal'] });
record({ name: 'duel facile contre facile jusqu\'à la fin', kind: 'versus', seed: 12, frames: 12000, players: ['easy', 'easy'] });
record({ name: 'duel au hasard', kind: 'versus', seed: 13, frames: 6000, players: ['chaos', 'chaos'] });
record({ name: 'duel difficile contre difficile', kind: 'versus', seed: 16, frames: 3000, players: ['hard', 'hard'] });
record({ name: 'solo difficile niveau 5', kind: 'solo', seed: 14, frames: 3000, players: ['hard'], startLevel: 5 });
record({ name: 'solo au hasard', kind: 'solo', seed: 15, frames: 5000, players: ['chaos'] });
record({ name: 'solo normal', kind: 'solo', seed: 17, frames: 4000, players: ['normal'] });

fs.writeFileSync(path.join(here, 'engine-vectors.json'), `${JSON.stringify({ games })}\n`);
const summary = games.map((g) => `${g.name}: ${g.frames} images, ${g.inputs.length} entrées, gagnant ${g.winner}`).join('\n');
console.log(summary);
