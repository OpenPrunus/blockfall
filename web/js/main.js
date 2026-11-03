// Blockfall — application : menus, boucle de jeu à 60 Hz (solo, contre l'ordinateur), mode en ligne (état envoyé par le serveur).
import { createBoard, createVersus, step, stepVersus, snapshot } from './engine.js';
import { createAI } from './ai.js';
import * as i18n from './i18n.js';
import * as audio from './audio.js';
import { Renderer } from './render.js';
import { Controller } from './input.js';
import { Net, playerToken } from './net.js';

const { t } = i18n;
const $ = (sel) => document.querySelector(sel);
const STEP_MS = 1000 / 60;
const COUNTDOWN_FRAMES = 180;

const canvas = $('#game');
const renderer = new Renderer(canvas);
const panels = { menu: $('#menu'), online: $('#online'), pause: $('#pause'), over: $('#over') };

// ---------------------------------------------------------------- réglages
const opts = { level: 'normal', start: 1, name: '' };
try { Object.assign(opts, JSON.parse(localStorage.getItem('blockfall.opts') ?? '{}')); } catch { /* réglages illisibles */ }
const saveOpts = () => { try { localStorage.setItem('blockfall.opts', JSON.stringify(opts)); } catch { /* ignoré */ } };
const randomSeed = () => (Math.floor(Math.random() * 0x7fffffff) + 1);

// ---------------------------------------------------------------- état
const app = {
  mode: null,           // null (menu : démonstration) | 'solo' | 'ai' | 'online'
  board: null,          // solo, ou démonstration
  versus: null,
  ai: null,
  names: ['', ''],
  countdown: 0,         // images avant le départ (solo, contre l'ordinateur)
  goUntil: 0,
  paused: false,
  acc: 0,
  last: 0,
  over: null,
  attract: { board: null, ai: null },
};
const online = {
  status: 'idle',       // idle | connecting | hello | lobby | queued | waiting | playing
  me: null,
  side: 0,
  players: [],
  invite: null,
  ranked: false,
  oppLeft: false,
  state: [{}, {}],      // état fusionné de chaque plateau (le serveur n'envoie que les changements)
  cd: 0,                // décompte annoncé par le serveur (secondes), 0 = en jeu
  oppName: '',
};

// ---------------------------------------------------------------- entrées
const net = new Net({
  onopen: () => {
    online.status = 'hello';
    setOnlineStatus('');
    $('#join').hidden = false;
    $('#lobby').hidden = true;
    $('#nick').focus();
  },
  onmessage: onServerMessage,
  onclose: (wasOpen) => {
    const inMatch = app.mode === 'online';
    closeOnlineSession();
    online.status = 'idle';
    if (inMatch || !panels.online.hidden || wasOpen) {
      showPanel('online');
      $('#join').hidden = true;
      $('#lobby').hidden = true;
      setOnlineStatus(t(wasOpen ? 'disconnected' : 'unreachable'), true);
    }
  },
});

const ctl = new Controller({
  onKeys: (held) => {
    if (held.l || held.r) audio.play('move');
    if (app.mode === 'online') net.sendKeys(held);
  },
  onAction: (a) => {
    audio.play(a === 'hd' ? 'drop' : a === 'hold' ? 'hold' : a === 'left' || a === 'right' ? 'move' : 'rotate');
    if (app.mode === 'online') net.sendAct(a);
  },
});
ctl.bindGestures($('#stage'), () => (renderer.units[0]?.c ?? 24) * (canvas.getBoundingClientRect().width / renderer.w));

const isTouchDevice = () => window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
const inGame = () => app.mode !== null && Object.values(panels).every((p) => p.hidden);

function updateInput() {
  const on = inGame() && !app.paused && !(app.mode !== 'online' && app.countdown > 0 && false);
  ctl.setEnabled(on);
  $('#pause-btn').hidden = app.mode === null;
  $('#fs-btn').hidden = !(app.mode !== null && canFullscreen());
  document.body.classList.toggle('playing', app.mode !== null && Object.values(panels).every((p) => p.hidden));
  keepAwake(app.mode !== null && isTouchDevice());
}

// ---------------------------------------------------------------- panneaux
function showPanel(name) {
  for (const [key, el] of Object.entries(panels)) el.hidden = key !== name;
  updateInput();
}
const hidePanels = () => showPanel('');

function refreshLabels() {
  i18n.apply(document);
  $('#opt-sound').textContent = `${t('sound')} : ${audio.isMuted() ? t('off') : t('on')}`;
  $('#opt-lang').textContent = `${t('language')} : ${i18n.getLang().toUpperCase()}`;
  $('#opt-fs').hidden = !canFullscreen();
  $('#opt-fs').textContent = t(document.fullscreenElement ? 'exitFullscreen' : 'fullscreen');
  $('#opt-level').value = opts.level;
  $('#opt-start').value = String(opts.start);
  $('#nick').value = opts.name ?? '';
  if (['lobby', 'queued', 'waiting'].includes(online.status)) renderLobby();
}

// ---------------------------------------------------------------- confort sur téléphone : plein écran, écran allumé
const canFullscreen = () => !!document.documentElement.requestFullscreen && isTouchDevice();

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      screen.orientation?.unlock?.();
    } else {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      await screen.orientation?.lock?.('landscape').catch(() => {});
    }
  } catch { /* refusé : sans importance */ }
}

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (!on) {
      await wakeLock?.release();
      wakeLock = null;
    } else if ('wakeLock' in navigator && !wakeLock && !document.hidden) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* indisponible ou refusé */ }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && app.mode !== null) keepAwake(true); });
document.addEventListener('fullscreenchange', () => { refreshLabels(); applyLayout(); });

// ---------------------------------------------------------------- disposition du canvas
function applyLayout() {
  const kind = window.innerHeight > window.innerWidth * 1.05 ? 'tall' : 'wide';
  const versus = app.mode === 'ai' || app.mode === 'online';
  if (kind !== renderer.kind || versus !== renderer.versus) renderer.setLayout(kind, versus);
  document.body.dataset.layout = kind;
  const stage = $('#stage');
  const cs = getComputedStyle(stage);
  const aw = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const ah = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const s = Math.min(aw / renderer.w, ah / renderer.h);
  canvas.style.width = `${Math.floor(renderer.w * s)}px`;
  canvas.style.height = `${Math.floor(renderer.h * s)}px`;
}
window.addEventListener('resize', applyLayout);
window.addEventListener('orientationchange', () => setTimeout(applyLayout, 150));
new ResizeObserver(applyLayout).observe($('#stage'));

// ---------------------------------------------------------------- démarrage des parties
function resetEffects() {
  renderer.fx = [];
  renderer.pops = [];
}

function startSolo() {
  closeOnlineSession();
  app.mode = 'solo';
  app.board = createBoard({ seed: randomSeed(), mode: 'marathon', startLevel: Number(opts.start) });
  app.versus = null;
  app.ai = null;
  app.names = [t('you'), ''];
  beginLocal();
}

function startAI() {
  closeOnlineSession();
  app.mode = 'ai';
  const seed = randomSeed();
  app.versus = createVersus({ seed });
  app.board = null;
  app.ai = createAI(opts.level, seed + 5);
  app.names = [t('you'), t('cpu')];
  beginLocal();
}

let gestureTipTimer = 0;
/** Au début d'une partie sur tactile, un rappel des gestes disparaît tout seul. */
function showGestureTip() {
  if (!isTouchDevice()) return;
  const el = $('#gesture-tip');
  el.classList.add('show');
  clearTimeout(gestureTipTimer);
  gestureTipTimer = setTimeout(() => el.classList.remove('show'), 6000);
}

function beginLocal() {
  app.countdown = COUNTDOWN_FRAMES;
  app.goUntil = 0;
  app.paused = false;
  app.over = null;
  app.acc = 0;
  resetEffects();
  ctl.releaseAll();
  ctl.actions = [];
  applyLayout();
  hidePanels();
  audio.unlock();
  showGestureTip();
}

function endSession() {
  app.mode = null;
  app.paused = false;
  app.board = null;
  app.versus = null;
  app.ai = null;
  closeOnlineSession();
  resetEffects();
  newAttract();
  applyLayout();
  showPanel('menu');
}

function setPaused(p) {
  if (app.mode === null || app.mode === 'online') return;
  app.paused = p;
  showPanel(p ? 'pause' : '');
}

// ---------------------------------------------------------------- événements du moteur : sons et effets
function handleEvents(u, events, own) {
  for (const e of events) {
    renderer.event(u, e);
    if (!own) continue;
    switch (e.t) {
      case 'lock': audio.play('lock'); break;
      case 'clear': audio.play(e.n === 4 ? 'tetris' : 'clear', e.n); break;
      case 'garbage': audio.play('garbage'); break;
      case 'attack': audio.play('attack'); break;
      default: break;
    }
  }
}

function newAttract() {
  const seed = randomSeed();
  app.attract.board = createBoard({ seed, mode: 'marathon', startLevel: 3 });
  app.attract.ai = createAI('normal', seed);
}

// ---------------------------------------------------------------- un pas de 1/60 s
function tickOnce() {
  if (app.mode === null) {
    const { board, ai } = app.attract;
    step(board, ai.decide(board));
    if (!board.alive) newAttract();
    return;
  }
  if (app.mode === 'online') return;
  if (app.countdown > 0) {
    if (app.countdown % 60 === 0) audio.play('count');
    if (--app.countdown === 0) {
      audio.play('go');
      app.goUntil = performance.now() + 700;
    }
    return;
  }
  if (app.mode === 'solo') {
    handleEvents(0, step(app.board, ctl.poll()), true);
    if (!app.board.alive && !app.over) finishSolo();
    return;
  }
  const v = app.versus;
  const evs = stepVersus(v, [ctl.poll(), app.ai.decide(v.boards[1])]);
  handleEvents(0, evs[0], true);
  handleEvents(1, evs[1], false);
  if (v.winner !== null && !app.over) finishAI();
}

// ---------------------------------------------------------------- fin de partie
function bestScore() {
  try { return Number(localStorage.getItem('blockfall.best') ?? 0) || 0; } catch { return 0; }
}

function finishSolo() {
  const b = app.board;
  const prev = bestScore();
  const record = b.score > prev;
  if (record) { try { localStorage.setItem('blockfall.best', String(b.score)); } catch { /* ignoré */ } }
  audio.play('lose');
  app.over = { solo: true };
  setTimeout(() => {
    if (app.mode !== 'solo') return;
    $('#over-title').textContent = t('gameOver');
    $('#over-detail').textContent = t('finalScore', { s: b.score, l: b.lines, lv: b.level });
    $('#over-extra').textContent = record ? t('newBest') : t('best', { s: prev });
    $('#over-again').textContent = t('playAgain');
    $('#over-again').disabled = false;
    $('#over-again').dataset.action = 'again';
    showPanel('over');
  }, 900);
}

function finishAI() {
  const v = app.versus;
  const won = v.winner === 0;
  audio.play(won ? 'win' : 'lose');
  app.over = { winner: v.winner };
  setTimeout(() => {
    if (app.mode !== 'ai') return;
    $('#over-title').textContent = t(won ? 'youWin' : 'youLose');
    $('#over-detail').textContent = t('duelDetail', { a: v.boards[0].lines, b: v.boards[1].lines });
    $('#over-extra').textContent = '';
    $('#over-again').textContent = t('playAgain');
    $('#over-again').disabled = false;
    $('#over-again').dataset.action = 'again';
    showPanel('over');
  }, 1200);
}

// ---------------------------------------------------------------- mode en ligne
function setOnlineStatus(text, error = false) {
  const el = $('#online-status');
  el.textContent = text;
  el.classList.toggle('error', error);
}

function openOnline() {
  closeOnlineSession();
  app.mode = null;
  showPanel('online');
  online.status = 'connecting';
  $('#join').hidden = true;
  $('#lobby').hidden = true;
  $('#invite').hidden = true;
  setOnlineStatus(t('connecting'));
  net.connect();
}

function closeOnlineSession() {
  if (app.mode === 'online') app.mode = null;
  online.invite = null;
  online.state = [{}, {}];
  online.cd = 0;
}

function leaveOnline() {
  net.close();
  closeOnlineSession();
  online.status = 'idle';
  app.mode = null;
  showPanel('menu');
}

const ERRORS = { bad_name: 'errName', name_taken: 'errTaken', busy: 'errBusy', rate: 'errRate', full: 'errFull', not_ready: 'errGeneric', bad_action: 'errAction' };

function onServerMessage(m) {
  switch (m.t) {
    case 'welcome':
      online.me = m;
      online.status = 'lobby';
      opts.name = m.name;
      saveOpts();
      $('#join').hidden = true;
      $('#lobby').hidden = false;
      setOnlineStatus('');
      renderLobby();
      loadBoard();
      break;
    case 'lobby':
      online.players = m.players;
      if (['lobby', 'queued', 'waiting'].includes(online.status)) renderLobby();
      break;
    case 'queued': online.status = 'queued'; renderLobby(); break;
    case 'unqueued': online.status = 'lobby'; renderLobby(); break;
    case 'waiting': online.status = 'waiting'; setOnlineStatus(t('waitingAnswer', { name: m.name })); break;
    case 'invite':
      online.invite = m;
      $('#invite-text').textContent = t('invitedYou', { name: m.name });
      $('#invite').hidden = false;
      audio.play('click');
      break;
    case 'invite_cancel':
      online.invite = null;
      $('#invite').hidden = true;
      if (online.status === 'waiting') online.status = 'lobby';
      renderLobby();
      break;
    case 'declined': online.status = 'lobby'; renderLobby(); setOnlineStatus(t('declined', { name: m.name })); break;
    case 'match': startOnlineMatch(m); break;
    case 'cd':
      online.cd = m.n;
      if (m.n > 0) audio.play('count');
      break;
    case 'go':
      online.cd = 0;
      app.goUntil = performance.now() + 700;
      audio.play('go');
      break;
    case 's': onState(m); break;
    case 'result': onResult(m); break;
    case 'oppleft': online.oppLeft = true; $('#over-again').disabled = true; break;
    case 'left': backToLobby(); break;
    case 'error':
      setOnlineStatus(t(ERRORS[m.code] ?? 'errGeneric'), true);
      if (online.status === 'waiting') online.status = 'lobby';
      if (app.mode !== 'online') renderLobby();
      break;
    default: break;
  }
}

const EVENT_NAMES = { clear: 'clear', garbage: 'garbage', attack: 'attack', lock: 'lock', hold: 'hold', dead: 'dead' };

function startOnlineMatch(m) {
  app.mode = 'online';
  app.board = null;
  app.versus = null;
  app.paused = false;
  app.over = null;
  app.countdown = 0;
  online.status = 'playing';
  online.side = m.side;
  online.ranked = m.ranked;
  online.oppLeft = false;
  online.invite = null;
  online.state = [{}, {}];
  online.cd = 3;
  online.oppName = m.opp.name;
  const me = online.me?.name ?? t('you');
  app.names = [me, m.opp.name];
  resetEffects();
  ctl.releaseAll();
  applyLayout();
  hidePanels();
  audio.unlock();
  showGestureTip();
}

function onState(m) {
  if (app.mode !== 'online') return;
  m.b.forEach((diff, i) => Object.assign(online.state[i], diff));
  for (const [side, type, n, rows] of m.ev ?? []) {
    const u = side === online.side ? 0 : 1;
    const name = EVENT_NAMES[type];
    if (!name) continue;
    handleEvents(u, [{ t: name, n, rows: rows ?? [] }], u === 0);
  }
}

function onResult(m) {
  app.over = m;
  const mine = m.winner === online.side;
  const delay = m.forfeit ? 200 : 1500;
  setTimeout(() => {
    if (app.mode !== 'online' || app.over !== m) return;
    $('#over-title').textContent = t(mine ? 'youWin' : 'youLose');
    const lines = m.lines[online.side];
    const theirs = m.lines[1 - online.side];
    const rating = m.delta !== undefined ? t('ratingDelta', { rating: m.rating, delta: (m.delta >= 0 ? '+' : '') + m.delta }) : (m.forfeit ? '' : t(m.ranked ? 'ranked' : 'unranked'));
    $('#over-detail').textContent = [t('duelDetail', { a: lines, b: theirs }), m.forfeit && mine ? t('oppLeft') : ''].filter(Boolean).join(' · ');
    $('#over-extra').textContent = rating;
    $('#over-again').textContent = t('rematch');
    $('#over-again').disabled = online.oppLeft;
    $('#over-again').dataset.action = 'rematch';
    showPanel('over');
  }, delay);
  if (!m.forfeit) audio.play(mine ? 'win' : 'lose');
}

function backToLobby() {
  app.mode = null;
  online.status = 'lobby';
  online.state = [{}, {}];
  resetEffects();
  applyLayout();
  showPanel('online');
  $('#lobby').hidden = false;
  $('#join').hidden = true;
  renderLobby();
  loadBoard();
}

function renderLobby() {
  const status = online.status;
  $('#quick').textContent = t(status === 'queued' ? 'cancelSearch' : 'quickMatch');
  $('#quick').disabled = status === 'waiting';
  $('#my-rating').textContent = online.me ? `${online.me.name} · ${online.me.rating ?? '—'}${online.me.ranked ? '' : ' · ' + t('unranked')}` : '';
  if (status === 'queued') setOnlineStatus(t('searching'));
  else if (status === 'lobby') setOnlineStatus('');
  const list = $('#players');
  list.replaceChildren();
  if (online.players.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = t('nobody');
    list.append(li);
  }
  for (const p of online.players) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${p.name}${p.rating ? ` (${p.rating})` : ''}`;
    const sub = document.createElement('span');
    sub.className = 'muted';
    sub.textContent = t({ lobby: 'waiting', queued: 'searchingState', playing: 'inMatch' }[p.status] ?? 'waiting');
    const btn = document.createElement('button');
    btn.className = 'btn small';
    btn.textContent = t('challenge');
    btn.disabled = !(p.status === 'lobby' || p.status === 'queued') || status === 'waiting';
    btn.addEventListener('click', () => net.send({ t: 'challenge', id: p.id }));
    li.append(label, sub, btn);
    list.append(li);
  }
}

async function loadBoard() {
  const body = $('#board');
  const message = (text) => {
    body.replaceChildren();
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.textContent = text;
    tr.append(td);
    body.append(tr);
  };
  try {
    const res = await fetch('api.php', { cache: 'no-store' });
    if (!res.ok) throw new Error('http');
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return message(t('noScores'));
    body.replaceChildren();
    for (const r of rows.slice(0, 5)) {
      const tr = document.createElement('tr');
      for (const v of [r.rank, r.name, r.rating, `${r.wins} / ${r.losses}`]) {
        const td = document.createElement('td');
        td.textContent = String(v);
        tr.append(td);
      }
      body.append(tr);
    }
  } catch {
    message(t('boardUnavailable'));
  }
  return undefined;
}

// ---------------------------------------------------------------- vues et rendu
/** Résumé d'un plateau (moteur ou serveur) → ce que sait dessiner le moteur de rendu. */
function toView(s, name) {
  return { g: s.g, p: s.p ?? null, queue: s.q ?? [], hold: s.h ?? -1, canHold: s.ch ?? true, score: s.sc ?? 0, lines: s.ln ?? 0, level: s.lv ?? 1, pending: s.pg ?? 0, al: s.al ?? true, name };
}

function currentFrame(now) {
  const labels = {
    hold: t('labelHold'), next: t('labelNext'), score: t('labelScore'), lines: t('labelLines'), level: t('labelLevel'),
    single: t('single'), double: t('double'), triple: t('triple'), tetris: t('tetris'),
  };
  let views;
  let overlay = null;
  if (app.mode === 'solo') {
    views = [toView(snapshot(app.board), app.names[0])];
  } else if (app.mode === 'ai') {
    views = app.versus.boards.map((b, i) => toView(snapshot(b), app.names[i]));
  } else if (app.mode === 'online') {
    views = [toView(online.state[online.side], app.names[0]), toView(online.state[1 - online.side], app.names[1])];
  } else {
    views = [toView(snapshot(app.attract.board), '')];
  }
  const count = app.mode === 'online' ? online.cd : Math.ceil(app.countdown / 60);
  if (app.mode !== null && count > 0) overlay = { text: String(count) };
  else if (app.mode !== null && app.goUntil > now) overlay = { text: t('go'), size: 90 };
  return { views, labels, overlay, time: now };
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(100, now - (app.last || now));
  app.last = now;
  if (!app.paused && !document.hidden) {
    app.acc += dt;
    while (app.acc >= STEP_MS) {
      app.acc -= STEP_MS;
      tickOnce();
    }
  }
  renderer.draw(currentFrame(now));
}

// ---------------------------------------------------------------- actions de l'interface
document.addEventListener('click', (e) => {
  const el = e.target instanceof Element ? e.target.closest('[data-action]') : null;
  if (!el) return;
  audio.unlock();
  audio.play('click');
  switch (el.dataset.action) {
    case 'solo': startSolo(); break;
    case 'ai': startAI(); break;
    case 'online': openOnline(); break;
    case 'resume': if (app.mode === 'online') showPanel(''); else setPaused(false); break;
    case 'again': if (app.mode === 'solo') startSolo(); else startAI(); break;
    case 'rematch': net.send({ t: 'rematch' }); $('#over-again').disabled = true; break;
    case 'quit':
      if (app.mode === 'online') { net.send({ t: 'leave' }); backToLobby(); } else endSession();
      break;
    default: break;
  }
});

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  audio.unlock();
  if ((e.key === 'Escape' || e.key === 'p' || e.key === 'P') && app.mode !== null && !e.repeat) {
    e.preventDefault();
    if (app.mode === 'online') showPanel(panels.pause.hidden ? 'pause' : '');
    else setPaused(!app.paused);
  }
});
window.addEventListener('blur', () => { if (app.mode === 'solo' || app.mode === 'ai') { if (inGame()) setPaused(true); } });
document.addEventListener('visibilitychange', () => { if (document.hidden && (app.mode === 'solo' || app.mode === 'ai') && inGame()) setPaused(true); });

$('#pause-btn').addEventListener('click', () => {
  if (app.mode === 'online') showPanel(panels.pause.hidden ? 'pause' : '');
  else setPaused(!app.paused);
});
$('#fs-btn').addEventListener('click', () => toggleFullscreen());
$('#opt-fs').addEventListener('click', () => toggleFullscreen());
$('#opt-level').addEventListener('change', (e) => { opts.level = e.target.value; saveOpts(); });
$('#opt-start').addEventListener('change', (e) => { opts.start = Number(e.target.value); saveOpts(); });
$('#opt-sound').addEventListener('click', () => { audio.unlock(); audio.setMuted(!audio.isMuted()); refreshLabels(); });
$('#opt-lang').addEventListener('click', () => { i18n.setLang(i18n.getLang() === 'fr' ? 'en' : 'fr'); refreshLabels(); });
$('#online-back').addEventListener('click', leaveOnline);
$('#quick').addEventListener('click', () => net.send({ t: online.status === 'queued' ? 'unqueue' : 'queue' }));
$('#invite-accept').addEventListener('click', () => {
  if (online.invite) net.send({ t: 'accept', id: online.invite.id });
  $('#invite').hidden = true;
});
$('#invite-decline').addEventListener('click', () => {
  if (online.invite) net.send({ t: 'decline', id: online.invite.id });
  online.invite = null;
  $('#invite').hidden = true;
});
$('#join').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#nick').value.trim();
  if (!name) { setOnlineStatus(t('errName'), true); return; }
  audio.unlock();
  net.send({ t: 'hello', name, token: playerToken() });
});

// ---------------------------------------------------------------- démarrage
i18n.setLang(i18n.detectLang());
newAttract();
refreshLabels();
applyLayout();
showPanel('menu');
requestAnimationFrame(frame);

// Accès pour les tests de bout en bout dans le navigateur.
window.__blockfall = { app, online, opts, net, ctl, renderer };
