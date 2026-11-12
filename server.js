'use strict';
/*
 * Lakdi Online – real-time 4-player Indian trump card game.
 * Zero dependencies: plain Node.js (v18+). Realtime via Server-Sent Events.
 * Run:  node server.js   then open http://localhost:3000
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'index.html');
const SUITS = ['S', 'H', 'C', 'D'];
const BOT_NAMES = ['Ravi', 'Priya', 'Arjun', 'Meera', 'Kabir', 'Anjali'];
const TIMING = { reveal: 900, revealHold: 2600, bot: 900, trickShow: 1700 };
const ROOM_IDLE_MS = 3 * 60 * 60 * 1000; // delete empty rooms after 3h

const rooms = new Map();

/* ---------------- cards ---------------- */
const newDeck = () => { const d = []; for (const s of SUITS) for (let r = 2; r <= 14; r++) d.push({ s, r }); return d; };
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const ck = c => c.r + c.s;
function sortHand(h, trump) {
  const order = [trump, ...SUITS.filter(s => s !== trump)];
  return h.sort((a, b) => order.indexOf(a.s) - order.indexOf(b.s) || b.r - a.r);
}

/* ---------------- rooms ---------------- */
function makeCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  let c;
  do { c = ''; for (let i = 0; i < 4; i++) c += A[crypto.randomInt(A.length)]; } while (rooms.has(c));
  return c;
}
const newToken = () => crypto.randomBytes(16).toString('hex');

function createRoom() {
  const r = {
    code: makeCode(), seats: [null, null, null, null], phase: 'lobby', decider: 11,
    match: 0, scores: [0, 0, 0, 0], history: [], clients: new Set(), timer: null, last: Date.now(),
    trump: null, draws: [], hands: [[], [], [], []], bids: [null, null, null, null], tricks: [0, 0, 0, 0],
    trick: [], firstLeader: 0, turn: 0, round: 0, played: new Set(), trickWinner: -1, lastTrick: null,
    results: null, seq: 0,
  };
  rooms.set(r.code, r);
  return r;
}

function schedule(r, fn, ms) {
  clearTimeout(r.timer);
  r.timer = setTimeout(() => { r.timer = null; fn(); }, ms);
}

/* ---------------- game flow ---------------- */
function startMatch(r) {
  clearTimeout(r.timer); r.timer = null;
  // Open 4 cards at a time until the deciding card (Joker/Jack by default) appears.
  const d = shuffle(newDeck());
  r.draws = []; let trump = null;
  for (let i = 0; i < 52 && !trump; i += 4) {
    const four = d.slice(i, i + 4);
    r.draws.push(four);
    const hit = four.find(c => c.r === r.decider);
    if (hit) trump = hit.s;
  }
  r.trump = trump;
  const d2 = shuffle(newDeck());
  r.hands = [0, 1, 2, 3].map(i => sortHand(d2.slice(i * 13, i * 13 + 13), trump));
  r.bids = [null, null, null, null];
  r.tricks = [0, 0, 0, 0];
  r.trick = []; r.round = 0; r.played = new Set(); r.trickWinner = -1; r.lastTrick = null; r.results = null;
  r.firstLeader = r.match % 4; r.turn = r.firstLeader;
  r.phase = 'trump'; r.seq++;
  broadcast(r);
  schedule(r, () => {
    r.phase = 'bidding'; r.turn = r.firstLeader;
    broadcast(r); botStep(r);
  }, r.draws.length * TIMING.reveal + TIMING.revealHold);
}

function doBid(r, seat, n) {
  if (r.phase !== 'bidding' || r.turn !== seat) return 'Not your turn';
  n = parseInt(n, 10);
  if (!(n >= 1 && n <= 13)) return 'Choose a number from 1 to 13';
  r.bids[seat] = n;
  r.turn = (seat + 1) % 4;
  if (r.bids.every(b => b !== null)) { r.phase = 'playing'; r.round = 1; r.turn = r.firstLeader; }
  broadcast(r); botStep(r);
  return null;
}

// Must follow the led suit. If you have a HIGHER card of that suit than the highest
// one played so far, you must throw a higher one. (Not needed once someone has cut
// with trump.) No card of the led suit -> throw any card, e.g. a trump to cut.
const legal = (r, hand) => {
  if (!r.trick.length) return hand;
  const led = r.trick[0].c.s;
  const f = hand.filter(c => c.s === led);
  if (!f.length) return hand;
  const cut = led !== r.trump && r.trick.some(t => t.c.s === r.trump);
  if (cut) return f;
  const top = Math.max(...r.trick.filter(t => t.c.s === led).map(t => t.c.r));
  const higher = f.filter(c => c.r > top);
  return higher.length ? higher : f;
};
const beats = (r, a, b) => (a.s === b.s ? a.r > b.r : a.s === r.trump);
function currentWinner(r) { let b = r.trick[0]; for (const t of r.trick) if (beats(r, t.c, b.c)) b = t; return b; }

function doPlay(r, seat, key) {
  if (r.phase !== 'playing' || r.turn !== seat || r.trickWinner >= 0) return 'Not your turn';
  const hand = r.hands[seat];
  const c = hand.find(x => ck(x) === key);
  if (!c) return 'You do not have that card';
  if (!legal(r, hand).includes(c)) return 'You must follow the suit that was led';
  r.hands[seat] = hand.filter(x => x !== c);
  r.trick.push({ p: seat, c });
  r.played.add(ck(c));
  if (r.trick.length === 4) {
    const w = currentWinner(r).p;
    r.trickWinner = w;
    broadcast(r);
    schedule(r, () => {
      r.tricks[w]++;
      r.lastTrick = { cards: r.trick, winner: w, round: r.round };
      r.trick = []; r.trickWinner = -1; r.turn = w;
      if (r.round >= 13) endMatch(r);
      else { r.round++; broadcast(r); botStep(r); }
    }, TIMING.trickShow);
  } else {
    r.turn = (seat + 1) % 4;
    broadcast(r); botStep(r);
  }
  return null;
}

function endMatch(r) {
  // Made your hand: 10 x what you said, plus 1 for each extra round (said 2, won 4 -> 22).
  // Missed it: minus 10 x what you said (said 2, won 1 -> -20).
  const pts = [0, 1, 2, 3].map(i => {
    const b = r.bids[i], t = r.tricks[i];
    return t >= b ? b * 10 + (t - b) : -b * 10;
  });
  r.scores = r.scores.map((s, i) => s + pts[i]);
  r.results = { bids: [...r.bids], tricks: [...r.tricks], pts };
  r.history.push({ match: r.match + 1, ...r.results });
  r.match++;
  r.phase = 'matchEnd';
  broadcast(r);
}

/* ---------------- computer players ---------------- */
function botBid(hand, T) {
  let e = 0;
  const by = {}; SUITS.forEach(s => (by[s] = hand.filter(c => c.s === s)));
  const nT = by[T].length;
  for (const s of SUITS) {
    const cs = by[s], has = r => cs.some(c => c.r === r), n = cs.length;
    if (s === T) {
      if (has(14)) e += 1;
      if (has(13)) e += n >= 2 ? 0.9 : 0.4;
      if (has(12)) e += n >= 3 ? 0.7 : 0.2;
      e += Math.max(0, n - 3) * 0.8;
    } else {
      if (has(14)) e += n <= 5 ? 0.95 : 0.7;
      if (has(13) && n >= 2 && n <= 5) e += has(14) ? 0.8 : 0.5;
      if (n === 0 && nT >= 2) e += 0.8;
      if (n === 1 && nT >= 3) e += 0.4;
    }
  }
  return Math.max(1, Math.min(13, Math.round(e)));
}

function botCard(r, seat) {
  const hand = r.hands[seat], T = r.trump;
  const low = a => a.reduce((x, y) => (y.r < x.r ? y : x));
  const high = a => a.reduce((x, y) => (y.r > x.r ? y : x));
  const nonT = hand.filter(c => c.s !== T);
  const isBoss = c => {
    for (let k = c.r + 1; k <= 14; k++)
      if (!r.played.has(k + c.s) && !hand.some(h => h.r === k && h.s === c.s)) return false;
    return true;
  };
  if (!r.trick.length) {
    const boss = nonT.filter(isBoss);
    if (boss.length) return high(boss);
    if (nonT.length) {
      const by = {}; nonT.forEach(c => (by[c.s] = by[c.s] || []).push(c));
      return low(Object.values(by).sort((a, b) => a.length - b.length)[0]);
    }
    return high(hand);
  }
  const led = r.trick[0].c.s, best = currentWinner(r).c, last = r.trick.length === 3;
  const follow = hand.some(c => c.s === led) ? legal(r, hand) : [];
  if (follow.length) {
    const winners = follow.filter(c => beats(r, c, best));
    if (!winners.length) return low(follow);
    if (last) return low(winners);
    const top = high(winners);
    return isBoss(top) ? top : low(winners);
  }
  const trumpWin = hand.filter(c => c.s === T && beats(r, c, best));
  if (trumpWin.length) return low(trumpWin);
  return nonT.length ? low(nonT) : low(hand);
}

function botStep(r) {
  if (r.timer) return;
  const s = r.seats[r.turn];
  if (!s || !s.bot) return;
  if (r.phase === 'bidding') schedule(r, () => doBid(r, r.turn, botBid(r.hands[r.turn], r.trump)), TIMING.bot);
  else if (r.phase === 'playing' && r.trickWinner < 0) schedule(r, () => doPlay(r, r.turn, ck(botCard(r, r.turn))), TIMING.bot);
}

/* ---------------- what each phone sees ---------------- */
function view(r, me) {
  const v = {
    code: r.code, you: me, phase: r.phase, decider: r.decider, match: r.match, seq: r.seq,
    seats: r.seats.map(s => s && { name: s.name, bot: s.bot, online: s.online }),
    scores: r.scores, history: r.history,
  };
  if (r.phase !== 'lobby') {
    Object.assign(v, {
      trump: r.trump, draws: r.draws, hand: r.hands[me], counts: r.hands.map(h => h.length),
      bids: r.bids, tricks: r.tricks, trick: r.trick, turn: r.turn, round: r.round,
      trickWinner: r.trickWinner, lastTrick: r.lastTrick, results: r.results,
    });
    if (r.phase === 'playing' && r.turn === me && r.trickWinner < 0) v.legal = legal(r, r.hands[me]).map(ck);
  }
  return v;
}

function broadcast(r) {
  r.last = Date.now();
  for (const cl of r.clients) {
    if (!r.seats[cl.seat] || r.seats[cl.seat].token !== cl.token) { sendGone(cl); continue; }
    cl.res.write(`data: ${JSON.stringify(view(r, cl.seat))}\n\n`);
  }
}
function sendGone(cl) { try { cl.res.write('event: gone\ndata: {}\n\n'); cl.res.end(); } catch (e) {} }

/* ---------------- HTTP ---------------- */
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readJSON(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', ch => { d += ch; if (d.length > 10000) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function events(req, res, u) {
  const r = rooms.get((u.searchParams.get('code') || '').toUpperCase());
  const token = u.searchParams.get('token') || '';
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  const seat = r ? r.seats.findIndex(s => s && s.token === token) : -1;
  if (seat < 0) { sendGone({ res }); return; }
  const cl = { res, seat, token };
  r.clients.add(cl);
  const s = r.seats[seat];
  s.online = true;
  if (s.bot && s.wasHuman) { s.bot = false; s.wasHuman = false; } // player came back: take seat back from computer
  broadcast(r);
  const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (e) {} }, 20000);
  req.on('close', () => {
    clearInterval(ka);
    r.clients.delete(cl);
    const still = [...r.clients].some(c => c.seat === seat && c.token === token);
    const st = r.seats[seat];
    if (!still && st && st.token === token && !st.bot) { st.online = false; broadcast(r); }
  });
}

function api(op, b, res) {
  const name = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 14);
  if (op === 'create') {
    if (!name) return send(res, 400, { error: 'Please enter your name' });
    const r = createRoom();
    const token = newToken();
    r.seats[0] = { name, token, bot: false, online: false };
    return send(res, 200, { code: r.code, token });
  }
  const r = rooms.get(String(b.code || '').toUpperCase().trim());
  if (!r) return send(res, 404, { error: 'Room not found. Check the code.' });
  r.last = Date.now();

  if (op === 'join') {
    if (!name) return send(res, 400, { error: 'Please enter your name' });
    if (r.phase !== 'lobby') return send(res, 409, { error: 'This game has already started.' });
    if (r.seats.some(s => s && s.name.toLowerCase() === name.toLowerCase())) return send(res, 409, { error: 'That name is taken in this room.' });
    const i = r.seats.findIndex(s => !s);
    if (i < 0) return send(res, 409, { error: 'Room is full (4 players).' });
    const token = newToken();
    r.seats[i] = { name, token, bot: false, online: false };
    broadcast(r);
    return send(res, 200, { code: r.code, token });
  }

  const seat = r.seats.findIndex(s => s && s.token === b.token);
  if (seat < 0) return send(res, 403, { error: 'You are not in this room.' });
  const host = seat === 0;
  const target = parseInt(b.seat, 10);
  let err = null;

  switch (op) {
    case 'addBot': {
      if (!host || r.phase !== 'lobby') { err = 'Only the host can do that'; break; }
      const i = r.seats.findIndex(s => !s);
      if (i < 0) { err = 'Room is full'; break; }
      const used = new Set(r.seats.filter(Boolean).map(s => s.name));
      r.seats[i] = { name: BOT_NAMES.find(n => !used.has(n)) || 'Bot ' + i, token: newToken(), bot: true, online: true };
      break;
    }
    case 'remove': {
      if (!host || r.phase !== 'lobby' || !(target >= 1 && target <= 3)) { err = 'Only the host can do that'; break; }
      r.seats[target] = null; // their phone gets "removed" on next broadcast
      break;
    }
    case 'decider': {
      if (!host || r.phase !== 'lobby') { err = 'Only the host can do that'; break; }
      const v = parseInt(b.r, 10);
      r.decider = [11, 12, 13, 14].includes(v) ? v : 11;
      break;
    }
    case 'start': {
      if (!host) { err = 'Only the host can start'; break; }
      if (!['lobby', 'matchEnd'].includes(r.phase)) { err = 'A match is already running'; break; }
      if (r.seats.some(s => !s)) { err = 'Need 4 players – invite friends or add computer players'; break; }
      startMatch(r);
      return send(res, 200, { ok: true });
    }
    case 'lobby': {
      if (!host || r.phase !== 'matchEnd') { err = 'Only the host can do that'; break; }
      r.phase = 'lobby'; r.scores = [0, 0, 0, 0]; r.history = []; r.match = 0;
      r.seats = r.seats.map(s => (s && s.bot && s.wasHuman ? { ...s, bot: false, wasHuman: false } : s));
      break;
    }
    case 'takeover': {
      const s = r.seats[target];
      if (!host || !s || s.bot || s.online) { err = 'Can only hand over a player who is offline'; break; }
      s.bot = true; s.wasHuman = true;
      broadcast(r); botStep(r);
      break;
    }
    case 'bid': err = doBid(r, seat, b.n); break;
    case 'play': err = doPlay(r, seat, String(b.card || '')); break;
    default: err = 'Unknown action';
  }
  if (err) return send(res, 400, { error: err });
  broadcast(r);
  return send(res, 200, { ok: true });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      fs.createReadStream(INDEX).pipe(res);
      return;
    }
    if (req.method === 'GET' && u.pathname === '/health') { res.end('ok'); return; }
    if (req.method === 'GET' && u.pathname === '/events') return events(req, res, u);
    if (req.method === 'POST' && u.pathname.startsWith('/api/')) {
      let body;
      try { body = await readJSON(req); } catch (e) { return send(res, 400, { error: 'Bad request' }); }
      return api(u.pathname.slice(5), body, res);
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Server error' });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) if (r.clients.size === 0 && now - r.last > ROOM_IDLE_MS) { clearTimeout(r.timer); rooms.delete(code); }
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => console.log(`Lakdi Online running on http://localhost:${PORT}`));
