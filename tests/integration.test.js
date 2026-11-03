// Intégration : le VRAI serveur PHP (server/server.php) sur un vrai port, avec des clients WebSocket.
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Bot, startGameServer, sleep, token, waitFor } from './helpers.js';

let server;
const bots = [];
const bot = async (name, tok) => {
  const b = await new Bot(server.url).open();
  bots.push(b);
  if (name) await b.hello(name, tok);
  return b;
};

before(async () => { server = await startGameServer({ BLOCKFALL_COUNTDOWN: '1', BLOCKFALL_REMATCH_TTL: '3' }); });
after(() => { for (const b of bots) b.close(); server?.stop(); });

/** Deux joueurs appariés ; renvoie leurs robots, le plateau de chacun et le premier état complet. */
async function match(prefix, tokens = true) {
  const a = await bot(`${prefix}1`, tokens ? token(`${prefix}1`) : null);
  const b = await bot(`${prefix}2`, tokens ? token(`${prefix}2`) : null);
  a.send({ t: 'queue' });
  await a.next('queued');
  b.send({ t: 'queue' });
  const [ma, mb] = await Promise.all([a.next('match'), b.next('match')]);
  return { a, b, ma, mb };
}

/** Le dernier état connu d'un plateau : on fusionne les changements reçus, comme le fait le navigateur. */
function merged(b, side) {
  const out = {};
  for (const m of b.of('s')) Object.assign(out, m.b[side]);
  return out;
}

describe('serveur de jeu', () => {
  test('poignée de main, pseudo, salon', async () => {
    const a = await bot('Alice');
    const c = await bot('Bob');
    assert.equal(a.last('welcome').name, 'Alice');
    await waitFor(() => a.last('lobby')?.players.some((p) => p.name === 'Bob'), 4000, 'Bob visible dans le salon');
    assert.equal(c.last('welcome').ranked, false);
  });

  test('un pseudo déjà pris ou invalide est refusé', async () => {
    const c = await bot(null);
    c.send({ t: 'hello', name: 'alice' });
    assert.equal((await c.next('error')).code, 'name_taken');
    c.send({ t: 'hello', name: '<>' });
    assert.equal((await c.next('error')).code, 'bad_name');
    c.send({ t: 'queue' });
    assert.equal((await c.next('error')).code, 'not_ready');
  });

  test('partie rapide : compte à rebours, départ, état complet des deux plateaux à 60 images par seconde', async () => {
    const { a, b, ma, mb } = await match('Rapide');
    assert.equal(ma.side + mb.side, 1);
    assert.equal(ma.ranked, true);
    assert.equal((await a.next('cd', 3000, true)).n, 1);
    await Promise.all([a.next('go', 4000), b.next('go', 4000)]);
    const first = a.of('s')[0];
    assert.ok(first, 'état complet dès le départ');
    for (const board of first.b) {
      assert.equal(board.g.length, 200);
      assert.equal(board.q.length, 5);
      assert.equal(board.al, true);
    }
    assert.deepEqual(first.b[0].q, first.b[1].q, 'les deux plateaux ont la même suite de pièces');
    // le compte à rebours d'une seconde dure 60 images : le serveur tient bien le rythme de 60 par seconde
    const cd = a.of('cd')[0];
    const go = a.of('go')[0];
    const elapsed = go.at - cd.at;
    assert.ok(elapsed >= 900 && elapsed <= 1250, `compte à rebours de 1 s : ${elapsed} ms entre l'annonce et le départ`);
    a.send({ t: 'leave' });
  });

  test('les touches et les actions d\'un joueur bougent sa pièce chez les deux joueurs', async () => {
    const { a, b, ma } = await match('Touches', false);
    await Promise.all([a.next('go', 4000), b.next('go', 4000)]);
    await waitFor(() => merged(b, ma.side).p, 3000, 'première pièce');
    const p0 = merged(b, ma.side).p;
    a.send({ t: 'keys', l: true, r: false, d: false });
    await sleep(80);
    a.send({ t: 'keys', l: false, r: false, d: false });
    a.send({ t: 'act', a: 'cw' });
    await waitFor(() => { const p = merged(b, ma.side).p; return p && p[2] !== p0[2] && p[1] !== p0[1]; }, 2000, 'pièce déplacée et tournée');
    const p1 = merged(b, ma.side).p;
    assert.ok(p1[2] < p0[2], `un pas à gauche (ou plus) : ${p0[2]} -> ${p1[2]}`);
    assert.equal(p1[1], (p0[1] + 1) % 4, 'rotation horaire');
    assert.deepEqual(merged(a, ma.side).p, merged(b, ma.side).p, 'les deux joueurs voient la même pièce');
    const other = merged(b, 1 - ma.side);
    assert.ok(other.p, 'et celle de l\'adversaire, qui n\'a rien touché');
    // chute dure : la pièce se pose et la grille change
    const g0 = merged(a, ma.side).g;
    a.send({ t: 'act', a: 'hd' });
    await waitFor(() => merged(b, ma.side).g !== g0, 2000, 'pièce posée');
    assert.match(merged(b, ma.side).g, /[1-7]/);
    a.send({ t: 'leave' });
    await b.next('oppleft');
  });

  test('celui dont le plateau se remplit perd : résultat, classement écrit sur disque, puis retour au salon', async () => {
    const { a, b, ma } = await match('Perdant');
    await Promise.all([a.next('go', 4000), b.next('go', 4000)]);
    const deadline = Date.now() + 20000;
    while (!a.last('result') && Date.now() < deadline) {
      a.send({ t: 'act', a: 'hd' });
      await sleep(70);
    }
    const [ra, rb] = await Promise.all([a.next('result', 3000, true), b.next('result', 3000, true)]);
    assert.equal(ra.winner, 1 - ma.side, 'celui qui empile au centre perd');
    assert.equal(ra.winner, rb.winner);
    assert.equal(ra.forfeit, false);
    assert.equal(ra.ranked, true);
    assert.ok(ra.delta < 0 && rb.delta > 0 && ra.delta + rb.delta === 0);
    const file = path.join(server.dataDir, 'ratings.json');
    await waitFor(() => fs.existsSync(file), 3000, 'ratings.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(saved.players.some((p) => p.name === 'Perdant1'));
    assert.ok(saved.players.every((p) => p.tokenHash.length === 64 && !JSON.stringify(p).includes(token('Perdant1'))), 'le jeton n\'est jamais stocké en clair');
    assert.equal(merged(a, ma.side).al, false, 'le plateau perdu est marqué comme tel');
    await Promise.all([a.next('left', 8000), b.next('left', 8000)]);
  });

  test('revanche : un nouveau compte à rebours, des plateaux neufs', async () => {
    const { a, b } = await match('Revanche', false);
    await Promise.all([a.next('go', 4000), b.next('go', 4000)]);
    a.send({ t: 'leave' });
    await b.next('oppleft');
    const rb = b.last('result');
    assert.equal(rb.forfeit, true);
    assert.equal(rb.ranked, false);
  });

  test('défi : invitation, refus, puis acceptation', async () => {
    const a = await bot('Defi1');
    const b = await bot('Defi2');
    await waitFor(() => a.last('lobby')?.players.some((p) => p.name === 'Defi2'), 4000, 'salon');
    const idB = a.last('lobby').players.find((p) => p.name === 'Defi2').id;
    a.send({ t: 'challenge', id: idB });
    const inv = await b.next('invite');
    assert.equal(inv.name, 'Defi1');
    b.send({ t: 'decline', id: inv.id });
    assert.equal((await a.next('declined')).name, 'Defi2');
    a.send({ t: 'challenge', id: idB });
    const inv2 = await b.next('invite');
    b.send({ t: 'accept', id: inv2.id });
    await Promise.all([a.next('match'), b.next('match')]);
    a.send({ t: 'leave' });
    await b.next('oppleft');
  });

  test('messages invalides : refusés ou ignorés, la connexion survit', async () => {
    const a = await bot('Robuste');
    for (const raw of ['', '{', '[]', '{"t":1}', '{"t":"zzz"}', 'x'.repeat(5000)]) a.ws.send(raw);
    a.send({ t: 'act', a: 'banana' });
    assert.equal((await a.next('error')).code, 'bad_action');
    a.send({ t: 'ping', c: 42 });
    assert.equal((await a.next('pong')).c, 42);
    assert.equal(a.closed, false);
  });

  test('un client qui n\'est pas WebSocket reçoit un refus HTTP', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/`).catch(() => null);
    assert.ok(res === null || res.status === 400);
  });
});
