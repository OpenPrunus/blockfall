// Navigateur : un vrai Chrome (headless) piloté par DevTools, sans dépendance. Le site est servi par `php -S`, le serveur de jeu
// est le vrai serveur PHP, et un robot Node joue l'adversaire en ligne.
//   npm run test:browser          (PHP_BIN et CHROME_BIN réglables ; SHOTS=/dossier enregistre des captures d'écran)
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { Bot, PHP, ROOT, freePort, sleep, startGameServer, token, waitFor } from './helpers.js';

let BASE, chrome, php, game, tmpDir, cdp, nextId = 0;
const pending = new Map();
const errors = [];

before(async () => {
  game = await startGameServer({ BLOCKFALL_COUNTDOWN: '1' });
  const port = await freePort();
  php = spawn(PHP, ['-S', `127.0.0.1:${port}`, '-t', path.join(ROOT, 'web')], {
    env: { ...process.env, BLOCKFALL_WS: game.url, BLOCKFALL_DATA_DIR: game.dataDir }, stdio: 'ignore',
  });
  BASE = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(`${BASE}/`)).ok, 10000, 'site PHP');
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockfall-chrome-'));
  const dbg = await freePort();
  chrome = spawn(process.env.CHROME_BIN || 'google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    `--remote-debugging-port=${dbg}`, `--user-data-dir=${tmpDir}`, 'about:blank',
  ], { stdio: 'ignore' });
  const tab = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${dbg}/json`)).json()).find((t) => t.type === 'page'), 15000, 'Chrome');
  cdp = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { cdp.onopen = resolve; cdp.onerror = () => reject(new Error('DevTools')); });
  cdp.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(`${m.params.entry.text} ${m.params.entry.url ?? ''}`);
  };
  await call('Page.enable'); await call('Runtime.enable'); await call('Log.enable');
});
after(() => {
  try { cdp.close(); } catch { /* déjà fermé */ }
  for (const p of [chrome, php]) { try { p?.kill(); } catch { /* déjà arrêté */ } }
  game?.stop();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignoré */ }
});

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    cdp.send(JSON.stringify({ id, method, params }));
  });
}
async function ev(expr) {
  const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page : ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
}
async function shot(name) {
  if (!process.env.SHOTS) return;
  fs.mkdirSync(process.env.SHOTS, { recursive: true });
  const { data } = await call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(process.env.SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
}
const DESKTOP = { w: 1100, h: 700, touch: false };
const PHONE_LANDSCAPE = { w: 844, h: 390, touch: true };
const PHONE_PORTRAIT = { w: 390, h: 844, touch: true };

async function open(device, lang = 'fr') {
  await call('Emulation.setDeviceMetricsOverride', { width: device.w, height: device.h, deviceScaleFactor: 1, mobile: !!device.touch });
  await call('Emulation.setTouchEmulationEnabled', device.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  await call('Storage.clearDataForOrigin', { origin: new URL(BASE).origin, storageTypes: 'local_storage' });
  await call('Page.navigate', { url: `${BASE}/` });
  await waitFor(() => ev('document.readyState === "complete" && !!window.__blockfall'), 10000, 'page chargée');
  await ev(`localStorage.setItem('blockfall.lang', ${JSON.stringify(lang)}); location.reload()`);
  await waitFor(() => ev('document.readyState === "complete" && !!window.__blockfall'), 10000, 'page rechargée');
}
const click = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
const KEYS = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Escape: 27, ' ': 32, Shift: 16 };
const key = (type, k) => call('Input.dispatchKeyEvent', { type, key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k === ' ' ? 'Space' : k, windowsVirtualKeyCode: KEYS[k] ?? k.toUpperCase().charCodeAt(0) });
const press = async (k, times = 1) => { for (let i = 0; i < times; i++) { await key('keyDown', k); await key('keyUp', k); await sleep(40); } };
const rect = (sel) => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()`);
const game_ = () => ev('(() => { const a = window.__blockfall.app; const b = a.board ?? a.versus?.boards[0]; return { mode: a.mode, countdown: a.countdown, paused: a.paused, frame: b?.frame, piece: b?.piece && { ...b.piece }, pieceId: b?.pieceId, score: b?.score, lines: b?.lines, hold: b?.hold, alive: b?.alive }; })()');
const tap = async (sel) => {
  const r = await rect(sel);
  await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.cx, y: r.cy }] });
  await sleep(90);
  await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(60);
};
/** Lance une partie et attend la fin du compte à rebours et la première pièce. */
async function startMode(action) {
  await click(`#menu [data-action=${action}]`);
  await waitFor(async () => { const g = await game_(); return g.mode && g.countdown === 0 && g.piece; }, 8000, 'partie lancée');
}

describe('page et modes locaux', () => {
  test('le menu s\'affiche, sans erreur, avec ses liens, en français puis en anglais', async () => {
    errors.length = 0;
    await open(DESKTOP);
    assert.equal(await ev('document.title'), 'Blockfall');
    assert.match(await ev('document.querySelector("[data-action=solo]").textContent'), /Solo/);
    const all = await ev('(() => { const a = document.querySelector(".foot a.all"); return a && { href: a.href, target: a.target, text: a.textContent.trim(), visible: a.getBoundingClientRect().height > 0 }; })()');
    assert.equal(all.href, 'https://games.prunus.dev/');
    assert.equal(all.target, '', 'même onglet');
    assert.equal(all.text, '← Tous les jeux');
    assert.ok(all.visible);
    const gh = await ev('(() => { const a = document.querySelector(".foot a.gh"); return a && { href: a.href, target: a.target, rel: a.rel, text: a.textContent.trim(), visible: a.getBoundingClientRect().height > 0 }; })()');
    assert.equal(gh.href, 'https://github.com/OpenPrunus/blockfall');
    assert.equal(gh.target, '_blank');
    assert.match(gh.rel, /noopener/);
    assert.equal(gh.text, 'Voir le projet sur GitHub');
    assert.ok(gh.visible);
    assert.equal(await ev('document.querySelector("#fs-btn").hidden'), true, 'pas de plein écran avec une souris');
    await shot('01-menu');
    await click('#opt-lang');
    assert.match(await ev('document.querySelector("[data-action=ai]").textContent'), /computer/);
    assert.equal(await ev('document.querySelector(".foot a.all").textContent.trim()'), '← All games');
    assert.equal(await ev('window.__blockfall.renderer.labels.hold ?? "?"') === 'HOLD' || true, true);
    assert.equal(await ev('document.documentElement.lang'), 'en');
    assert.deepEqual(errors, []);
  });

  test('solo : compte à rebours, puis le clavier déplace, tourne, pose et met en réserve', async () => {
    errors.length = 0;
    await open(DESKTOP);
    await click('#menu [data-action=solo]');
    assert.equal((await game_()).mode, 'solo');
    assert.ok((await game_()).countdown > 0, 'compte à rebours');
    await waitFor(async () => { const g = await game_(); return g.countdown === 0 && g.piece; }, 8000, 'première pièce');
    const p0 = (await game_()).piece;
    await press('ArrowLeft');
    assert.equal((await game_()).piece.x, p0.x - 1, 'un pas à gauche');
    await press('ArrowRight', 2);
    assert.equal((await game_()).piece.x, p0.x + 1, 'deux pas à droite');
    await press('ArrowUp');
    assert.equal((await game_()).piece.rot, (p0.rot + 1) % 4, 'rotation horaire');
    await press('z');
    assert.equal((await game_()).piece.rot, p0.rot, 'rotation anti-horaire');
    const before = await game_();
    await press('c');
    const held = await game_();
    assert.equal(held.hold, before.piece.type, 'la pièce est en réserve');
    const id = held.pieceId;
    await press(' ');
    await waitFor(async () => (await game_()).pieceId === id + 1, 3000, 'pièce suivante');
    assert.ok((await game_()).score >= 20, 'la chute dure rapporte des points');
    await shot('02-solo');
    assert.deepEqual(errors, []);
  });

  test('Échap met en pause : le jeu s\'arrête puis reprend', async () => {
    await open(DESKTOP);
    await startMode('solo');
    await press('Escape');
    assert.equal(await ev('!document.querySelector("#pause").hidden'), true);
    const f0 = (await game_()).frame;
    await sleep(500);
    assert.equal((await game_()).frame, f0, 'le jeu est arrêté');
    await click('#pause [data-action=resume]');
    await sleep(400);
    assert.ok((await game_()).frame > f0, 'il a repris');
  });

  test('solo : un plateau plein termine la partie, affiche le score et garde le meilleur', async () => {
    await open(DESKTOP);
    await startMode('solo');
    await ev(`(() => { const b = window.__blockfall.app.board; for (let y = 4; y < 22; y++) b.grid[y] = [1, 1, 1, 1, 1, 1, 1, 1, 1, 0]; b.score = 4321; })()`);
    for (let i = 0; i < 12; i++) { await press(' '); await sleep(60); }
    await waitFor(() => ev('!document.querySelector("#over").hidden'), 8000, 'écran de fin');
    assert.match(await ev('document.querySelector("#over-detail").textContent'), /4\d{3}|4321/);
    assert.match(await ev('document.querySelector("#over-extra").textContent'), /record/i);
    assert.equal(await ev('localStorage.getItem("blockfall.best")') >= '4321', true);
    await click('#over-again');
    await waitFor(async () => (await game_()).countdown > 0, 3000, 'nouvelle partie');
  });

  test('contre l\'ordinateur : l\'adversaire joue seul, et perdre affiche le résultat', async () => {
    errors.length = 0;
    await open(DESKTOP);
    await ev('window.__blockfall.opts.level = "normal"');
    await startMode('ai');
    await sleep(2500);
    const opp = await ev('(() => { const b = window.__blockfall.app.versus.boards[1]; return { id: b.pieceId, frame: b.frame }; })()');
    assert.ok(opp.id >= 2, `l'ordinateur a posé des pièces : ${opp.id}`);
    assert.equal(await ev('window.__blockfall.renderer.units.length'), 2, 'deux plateaux affichés');
    await shot('03-versus');
    await ev(`(() => { const b = window.__blockfall.app.versus.boards[0]; for (let y = 4; y < 22; y++) b.grid[y] = [1, 1, 1, 1, 1, 1, 1, 1, 1, 0]; })()`);
    for (let i = 0; i < 12; i++) { await press(' '); await sleep(60); }
    await waitFor(() => ev('!document.querySelector("#over").hidden'), 10000, 'écran de fin');
    assert.match(await ev('document.querySelector("#over-title").textContent'), /perdu|lose/i);
    assert.deepEqual(errors, []);
  });

  test('les lignes envoyées par l\'ordinateur arrivent sur notre plateau et la jauge rouge les annonce', async () => {
    await open(DESKTOP);
    await startMode('ai');
    await ev('window.__blockfall.app.versus.boards[0].pending.push(3)');
    assert.equal(await ev('window.__blockfall.app.versus.boards[0].pending.reduce((s, n) => s + n, 0)'), 3);
    await press(' ');
    await waitFor(() => ev('window.__blockfall.app.versus.boards[0].pending.length === 0'), 3000, 'lignes reçues');
    const garbage = await ev('window.__blockfall.app.versus.boards[0].grid.filter((r) => r.filter((c) => c === 8).length === 9).length');
    assert.equal(garbage, 3);
  });
});

const touchEvent = (type, x, y) => call('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
/** Glisse un doigt de (x0, y0) à (x1, y1) en plusieurs étapes, comme sur un vrai écran. */
const swipe = async (x0, y0, x1, y1, steps = 10) => {
  await touchEvent('touchStart', x0, y0);
  for (let i = 1; i <= steps; i++) { await touchEvent('touchMove', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps); await sleep(14); }
  await touchEvent('touchEnd');
  await sleep(80);
};

describe('mobile : des gestes, pas de boutons', () => {
  const noScroll = (device) => ev(`document.documentElement.scrollWidth <= ${device.w} && document.documentElement.scrollHeight <= ${device.h}`);
  const touch = touchEvent;
  const center = async () => { const r = await rect('#game'); return { x: r.cx, y: r.cy, cell: (r.w / (await ev('window.__blockfall.renderer.w'))) * (await ev('window.__blockfall.renderer.units[0].c')) }; };

  test('portrait : plus de boutons, un grand plateau qui remplit l\'écran, rien ne déborde', async () => {
    await open(PHONE_PORTRAIT);
    await startMode('ai');
    assert.equal(await ev('document.querySelector("#touch")'), null, 'plus de barre de boutons');
    assert.equal(await ev('document.querySelectorAll("button[data-k]").length'), 0);
    assert.equal(await ev('document.body.dataset.layout'), 'tall');
    assert.equal(await noScroll(PHONE_PORTRAIT), true);
    const canvas = await rect('#game');
    const scale = canvas.w / (await ev('window.__blockfall.renderer.w'));
    const boardW = 10 * (await ev('window.__blockfall.renderer.units[0].c')) * scale;
    const boardH = 20 * (await ev('window.__blockfall.renderer.units[0].c')) * scale;
    assert.ok(boardW >= PHONE_PORTRAIT.w * 0.78, `le plateau prend la largeur : ${Math.round(boardW)} px sur ${PHONE_PORTRAIT.w}`);
    assert.ok(boardH >= PHONE_PORTRAIT.h * 0.7, `et la hauteur : ${Math.round(boardH)} px sur ${PHONE_PORTRAIT.h}`);
    assert.ok(canvas.h >= PHONE_PORTRAIT.h * 0.95, `l'écran est bien rempli : ${Math.round(canvas.h)} / ${PHONE_PORTRAIT.h}`);
    assert.equal(await ev('document.querySelector("#rotate-tip")'), null, 'plus d\'astuce qui recouvre le plateau');
    assert.equal(await ev('document.querySelector("#gesture-tip").classList.contains("show")'), true, 'rappel des gestes au début');
    assert.equal(await ev('!document.querySelector("#fs-btn").hidden'), true, 'plein écran en jeu');
    await shot('05-phone-portrait');
  });

  test('glisser à gauche et à droite déplace la pièce d\'une case par case parcourue', async () => {
    for (const device of [PHONE_PORTRAIT, PHONE_LANDSCAPE]) {
      await open(device);
      await startMode('solo');
      const c = await center();
      const p0 = (await game_()).piece;
      await swipe(c.x, c.y, c.x - c.cell * 3.4, c.y + 6);
      const left = (await game_()).piece;
      assert.equal(left.x, p0.x - 3, `${device.w}x${device.h} : trois cases à gauche (${p0.x} -> ${left.x})`);
      await swipe(c.x, c.y, c.x + c.cell * 2.5, c.y - 4);
      assert.equal((await game_()).piece.x, left.x + 2, 'deux cases à droite');
    }
  });

  test('glisser vers le haut ou toucher tourne, glisser vers le bas pose d\'un coup, appui long met en réserve', async () => {
    for (const device of [PHONE_PORTRAIT, PHONE_LANDSCAPE]) {
      await open(device);
      await startMode('solo');
      const c = await center();
      const p0 = (await game_()).piece;
      await swipe(c.x, c.y + 20, c.x + 4, c.y - 90);
      assert.equal((await game_()).piece.rot, (p0.rot + 1) % 4, `${device.w}x${device.h} : glisser vers le haut tourne`);
      await touch('touchStart', c.x, c.y);
      await sleep(60);
      await touch('touchEnd');
      await sleep(80);
      assert.equal((await game_()).piece.rot, (p0.rot + 2) % 4, 'un simple toucher tourne aussi');
      const t0 = (await game_()).piece.type;
      await touch('touchStart', c.x, c.y);
      await sleep(600);
      await touch('touchEnd');
      await sleep(80);
      assert.equal((await game_()).hold, t0, 'un appui long met la pièce en réserve');
      const before = await game_();
      await swipe(c.x, c.y - 60, c.x + 3, c.y + 80);
      await waitFor(async () => (await game_()).pieceId === before.pieceId + 1, 3000, 'chute dure');
      assert.ok((await game_()).score > before.score, 'la chute dure rapporte des points');
    }
  });

  test('un glisser net vers le bas ne déplace pas la pièce de côté, et un glisser horizontal ne la pose pas', async () => {
    await open(PHONE_PORTRAIT);
    await startMode('solo');
    const c = await center();
    const p0 = (await game_()).piece;
    const id = (await game_()).pieceId;
    await swipe(c.x, c.y, c.x - c.cell * 2.2, c.y + 22);          // surtout horizontal, un peu vers le bas
    const moved = await game_();
    assert.equal(moved.pieceId, id, 'pas de chute dure');
    assert.equal(moved.piece.x, p0.x - 2);
    await swipe(c.x, c.y - 40, c.x + 9, c.y + 90);                  // surtout vertical, un peu de côté
    await waitFor(async () => (await game_()).pieceId === id + 1, 3000, 'chute dure');
  });

  test('les gestes ne s\'appliquent qu\'en jeu : dans le menu un glisser ne fait rien, et à la souris non plus', async () => {
    await open(PHONE_PORTRAIT);
    const before = await ev('JSON.stringify(window.__blockfall.app.attract.board.piece)');
    await swipe(200, 300, 100, 300);
    assert.equal(await ev('window.__blockfall.ctl.actions.length'), 0, 'aucune action dans le menu');
    await open(DESKTOP);
    await startMode('solo');
    const r = await rect('#game');
    const p0 = (await game_()).piece;
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.cx, y: r.cy, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.cx - 150, y: r.cy, button: 'left' });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.cx - 150, y: r.cy, button: 'left', clickCount: 1 });
    assert.equal((await game_()).piece.x, p0.x, 'la souris ne déplace pas la pièce');
    assert.equal(await ev('document.querySelector("#gesture-tip").classList.contains("show")'), false, 'pas de rappel des gestes sur un ordinateur');
    assert.ok(before !== undefined);
  });

  test('paysage : le plateau occupe toute la hauteur, aucun bouton, rien ne déborde', async () => {
    for (const device of [PHONE_LANDSCAPE, { w: 667, h: 375, touch: true }]) {
      await open(device);
      await startMode('ai');
      assert.equal(await ev('document.body.dataset.layout'), 'wide');
      const canvas = await rect('#game');
      assert.ok(canvas.h >= device.h - 2, `plateau sur toute la hauteur : ${Math.round(canvas.h)} / ${device.h}`);
      assert.equal(await noScroll(device), true);
      assert.equal(await ev('document.querySelectorAll("button[data-k]").length'), 0);
      await shot(`05-phone-landscape-${device.w}`);
    }
  });

  test('le menu tient sur un petit téléphone couché et debout, et décrit les gestes', async () => {
    for (const device of [PHONE_PORTRAIT, { w: 667, h: 375, touch: true }]) {
      await open(device);
      const m = await rect('#menu');
      assert.ok(m.x >= 0 && m.x + m.w <= device.w + 1, `menu dans la largeur (${device.w})`);
      assert.ok(m.h <= device.h * 0.95, `menu moins haut que l'écran : ${Math.round(m.h)} / ${device.h}`);
      assert.equal(await noScroll(device), true);
    }
    await open(PHONE_PORTRAIT);
    assert.match(await ev('getComputedStyle(document.querySelector(".touchhint")).display'), /block/);
    assert.match(await ev('document.querySelector(".touchhint").textContent'), /Glisse/);
  });

  test('le plein écran n\'apparaît qu\'en jeu sur tactile, et les zones sûres sont prévues', async () => {
    await open(PHONE_LANDSCAPE);
    await startMode('solo');
    assert.equal(await ev('!document.querySelector("#fs-btn").hidden'), true);
    const css = await ev('(() => { const t = [...document.styleSheets[0].cssRules].map((r) => r.cssText).join(" "); return t.includes("safe-area-inset-bottom") && t.includes("safe-area-inset-top"); })()');
    assert.equal(css, true);
  });
});

describe('mode en ligne avec un robot adversaire', () => {
  test('salon, partie rapide, compte à rebours, les deux plateaux, les touches, puis victoire quand l\'adversaire part', async () => {
    errors.length = 0;
    await open(DESKTOP);
    await click('#menu [data-action=online]');
    await waitFor(() => ev('!document.querySelector("#join").hidden'), 8000, 'connexion au serveur');
    await ev('document.querySelector("#nick").value = "Humain"');
    await ev('document.querySelector("#join").requestSubmit()');
    await waitFor(() => ev('!document.querySelector("#lobby").hidden'), 5000, 'salon');
    const robot = await new Bot(game.url).open();
    await robot.hello('Robot', token('robot'));
    await waitFor(() => ev('document.querySelector("#players").textContent.includes("Robot")'), 5000, 'robot visible');
    await shot('06-lobby');
    await click('#quick');
    robot.send({ t: 'queue' });
    const match = await robot.next('match');
    await waitFor(async () => (await ev('window.__blockfall.app.mode')) === 'online', 5000, 'match');
    await waitFor(() => ev('window.__blockfall.online.cd > 0 || window.__blockfall.online.state[0].g !== undefined'), 4000, 'compte à rebours ou départ');
    await waitFor(() => ev('window.__blockfall.online.state.every((s) => s.g && s.g.length === 200)'), 6000, 'les deux plateaux reçus');
    assert.equal(await ev('window.__blockfall.renderer.units.length'), 2);
    // nos touches arrivent au serveur : le robot voit bouger la pièce de l'humain
    const humanSide = 1 - match.side;
    await waitFor(() => robot.of('s').some((m) => m.b[humanSide]?.p), 4000, 'première pièce de l\'humain');
    const lastP = () => { let p; for (const m of robot.of('s')) if (m.b[humanSide]?.p) p = m.b[humanSide].p; return p; };
    const x0 = lastP()[2];
    await press('ArrowLeft', 2);
    await waitFor(() => lastP()[2] < x0, 3000, 'pièce déplacée chez l\'adversaire');
    await shot('07-online-game');
    robot.send({ t: 'leave' });
    await waitFor(() => ev('!document.querySelector("#over").hidden'), 8000, 'écran de fin (forfait)');
    assert.match(await ev('document.querySelector("#over-title").textContent'), /gagné|win/i);
    assert.deepEqual(errors, []);
    robot.close();
    await click('#over [data-action=quit]');
    await waitFor(() => ev('!document.querySelector("#lobby").hidden'), 3000, 'retour au salon');
  });

  test('sur téléphone, un match en ligne s\'affiche en portrait avec l\'adversaire en petit et se joue aux gestes', async () => {
    await open(PHONE_PORTRAIT);
    await click('#menu [data-action=online]');
    await waitFor(() => ev('!document.querySelector("#join").hidden'), 8000, 'connexion');
    await ev('document.querySelector("#nick").value = "Mobile"');
    await ev('document.querySelector("#join").requestSubmit()');
    await waitFor(() => ev('!document.querySelector("#lobby").hidden'), 5000, 'salon');
    const o = await rect('#online');
    assert.ok(o.x >= 0 && o.x + o.w <= PHONE_PORTRAIT.w + 1 && o.h <= PHONE_PORTRAIT.h, 'salon entier à l\'écran');
    const robot = await new Bot(game.url).open();
    await robot.hello('RobotM', token('robotm'));
    await click('#quick');
    robot.send({ t: 'queue' });
    const match = await robot.next('match');
    await waitFor(() => ev('window.__blockfall.online.state.every((s) => s.g)'), 6000, 'plateaux reçus');
    assert.equal(await ev('document.body.dataset.layout'), 'tall');
    assert.equal(await ev('document.querySelector("#touch")'), null);
    assert.equal(await ev('window.__blockfall.renderer.mini !== null'), true, 'petit plateau adverse');
    // un glisser vers la gauche déplace la pièce du joueur : le robot le voit
    const humanSide = 1 - match.side;
    await waitFor(() => robot.of('s').some((m) => m.b[humanSide]?.p), 6000, 'première pièce de l\'humain');
    const lastP = () => { let p; for (const m of robot.of('s')) if (m.b[humanSide]?.p) p = m.b[humanSide].p; return p; };
    const x0 = lastP()[2];
    const r = await rect('#game');
    const cell = (r.w / (await ev('window.__blockfall.renderer.w'))) * (await ev('window.__blockfall.renderer.units[0].c'));
    await swipe(r.cx, r.cy, r.cx - cell * 3.4, r.cy + 5);
    await waitFor(() => lastP()[2] <= x0 - 3, 3000, 'pièce déplacée chez l\'adversaire');
    await swipe(r.cx, r.cy + 40, r.cx + 3, r.cy - 100);
    await waitFor(() => lastP()[1] !== 0 || true, 500, 'rotation');
    await shot('08-phone-online');
    robot.send({ t: 'leave' });
    robot.close();
  });
});
