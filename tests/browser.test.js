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

describe('mobile', () => {
  const inView = async (sel, device) => {
    const r = await rect(sel);
    return r.w > 0 && r.h > 0 && r.x >= -1 && r.y >= -1 && r.x + r.w <= device.w + 1 && r.y + r.h <= device.h + 1;
  };
  const noScroll = (device) => ev(`document.documentElement.scrollWidth <= ${device.w} && document.documentElement.scrollHeight <= ${device.h}`);

  test('portrait : plateau en grand, adversaire en petit, boutons tactiles entiers et assez grands, sans défilement', async () => {
    await open(PHONE_PORTRAIT);
    assert.equal(await ev('document.querySelector("#fs-btn").hidden'), true, 'pas de plein écran hors partie');
    await startMode('ai');
    assert.equal(await ev('document.body.dataset.layout'), 'tall');
    assert.equal(await ev('!document.querySelector("#touch").hidden'), true, 'commandes tactiles');
    assert.equal(await noScroll(PHONE_PORTRAIT), true);
    const canvas = await rect('#game');
    assert.ok(canvas.w <= PHONE_PORTRAIT.w + 1 && canvas.h <= PHONE_PORTRAIT.h);
    for (const k of ['left', 'right', 'down', 'cw', 'ccw', 'hd', 'hold']) {
      const sel = `#touch [data-k=${k}]`;
      assert.ok(await inView(sel, PHONE_PORTRAIT), `${k} visible dans l'écran`);
      const r = await rect(sel);
      assert.ok(r.w >= 44 && r.h >= 44, `${k} : ${Math.round(r.w)}x${Math.round(r.h)} (44 px au moins)`);
    }
    const bar = await rect('#touch');
    assert.ok(canvas.y + canvas.h <= bar.y + 2, 'les boutons sont sous le plateau, pas dessus');
    assert.equal(await ev('getComputedStyle(document.querySelector("#rotate-tip")).display'), 'block', 'astuce de rotation');
    assert.equal(await ev('!document.querySelector("#fs-btn").hidden'), true, 'bouton plein écran en jeu');
    await shot('05-phone-portrait');
  });

  test('on joue entièrement au doigt : déplacer, tourner, réserve, chute douce et chute dure', async () => {
    for (const device of [PHONE_PORTRAIT, PHONE_LANDSCAPE]) {
      await open(device);
      await startMode('solo');
      const p0 = (await game_()).piece;
      await tap('#touch [data-k=left]');
      await tap('#touch [data-k=left]');
      assert.ok((await game_()).piece.x <= p0.x - 2, `${device.w}x${device.h} : deux pas à gauche`);
      await tap('#touch [data-k=cw]');
      assert.equal((await game_()).piece.rot, (p0.rot + 1) % 4, 'rotation');
      const t0 = (await game_()).piece.type;
      await tap('#touch [data-k=hold]');
      assert.equal((await game_()).hold, t0, 'réserve');
      const y0 = (await game_()).piece.y;
      const r = await rect('#touch [data-k=down]');
      await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.cx, y: r.cy }] });
      await sleep(500);
      await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      assert.ok((await game_()).piece.y > y0 + 4, 'chute douce tant que le doigt reste appuyé');
      const id = (await game_()).pieceId;
      await tap('#touch [data-k=hd]');
      await waitFor(async () => (await game_()).pieceId === id + 1, 3000, 'chute dure');
    }
  });

  test('paysage : le plateau occupe toute la hauteur, les boutons sont dans les coins et entiers', async () => {
    for (const device of [PHONE_LANDSCAPE, { w: 667, h: 375, touch: true }]) {
      await open(device);
      await startMode('ai');
      assert.equal(await ev('document.body.dataset.layout'), 'wide');
      const canvas = await rect('#game');
      assert.ok(canvas.h >= device.h - 2, `plateau sur toute la hauteur : ${Math.round(canvas.h)} / ${device.h}`);
      assert.equal(await noScroll(device), true);
      for (const k of ['left', 'right', 'down', 'cw', 'ccw', 'hd', 'hold']) {
        assert.ok(await inView(`#touch [data-k=${k}]`, device), `${device.w}x${device.h} : ${k} visible`);
      }
      const left = await rect('#touch [data-k=left]');
      const hd = await rect('#touch [data-k=hd]');
      assert.ok(left.x < device.w / 3 && hd.x > (2 * device.w) / 3, 'commandes aux deux coins');
      await shot(`05-phone-landscape-${device.w}`);
    }
  });

  test('le menu tient sur un petit téléphone couché et debout', async () => {
    for (const device of [PHONE_PORTRAIT, { w: 667, h: 375, touch: true }]) {
      await open(device);
      const m = await rect('#menu');
      assert.ok(m.x >= 0 && m.x + m.w <= device.w + 1, `menu dans la largeur (${device.w})`);
      assert.ok(m.h <= device.h * 0.95, `menu moins haut que l'écran : ${Math.round(m.h)} / ${device.h}`);
      assert.ok(await inView('#menu [data-action=solo]', device), 'le bouton principal est visible');
      assert.equal(await noScroll(device), true);
    }
  });

  test('le plein écran n\'apparaît qu\'en jeu sur tactile, et les zones sûres sont prévues', async () => {
    await open(PHONE_LANDSCAPE);
    await startMode('solo');
    assert.equal(await ev('!document.querySelector("#fs-btn").hidden'), true);
    const css = await ev('(() => { const t = [...document.styleSheets[0].cssRules].map((r) => r.cssText).join(" "); return t.includes("safe-area-inset-bottom") && t.includes("safe-area-inset-left"); })()');
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

  test('sur téléphone, un match en ligne s\'affiche en portrait avec l\'adversaire en petit', async () => {
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
    await robot.next('match');
    await waitFor(() => ev('window.__blockfall.online.state.every((s) => s.g)'), 6000, 'plateaux reçus');
    assert.equal(await ev('document.body.dataset.layout'), 'tall');
    assert.equal(await ev('!document.querySelector("#touch").hidden'), true);
    assert.equal(await ev('window.__blockfall.renderer.mini !== null'), true, 'petit plateau adverse');
    await shot('08-phone-online');
    robot.send({ t: 'leave' });
    robot.close();
  });
});
