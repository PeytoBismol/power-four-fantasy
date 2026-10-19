'use strict';

// Power Four Fantasy client. Hash routes, cookie session, one fetch per screen.
// Markup comes from views.js (loaded first). Every server string goes through esc().

const BENCH = 'BN';
const AUTH_ROUTES = new Set(['login', 'signup', 'forgot']);
const PLAIN_ROUTES = new Set(['login', 'signup', 'forgot', 'leagues', 'new', 'join', 'history', 'recovery']);
const TABS = ['home', 'team', 'players', 'scores', 'chat', 'draft', 'trades', 'settings'];
const THEME_KEY = 'pf-theme';
const LIVE_REFRESH_MS = 60 * 1000;
const DEFAULTS = {
  team_count: 10,
  regular_weeks: 15,
  playoff_teams: 4,
  pick_seconds: 90,
  format: 'h2h',
  waiver_mode: 'priority',
  faab_budget: 100,
  best_ball: false,
  trade_deadline_week: 0
};
const enc = encodeURIComponent;

const S = {
  me: null,
  meta: null,
  view: null,          // last built screen, any kind
  data: null,          // last league screen, or null
  routeKey: null,
  leagueId: null,
  leagueSig: null,
  liveDue: 0,          // when to repaint scores while games are on (0 = no live games on screen)
  scoreWeek: null,
  openMatch: -1,
  openReact: null,     // message id whose reaction picker is open
  players: { q: '', pos: 'ALL', group: 'ALL' },
  draft: { dq: '', dpos: 'ALL' },
  draftSig: null,
  trade: freshTrade(),
  chatLast: 0,
  chatSig: null,
  recoveryCode: null,  // shown once after sign-up or a reset, kept only in memory
  theme: 'system',
  sheetName: ''
};

const busy = {};
const timers = {};
let renderSeq = 0;
let toastTimer = null;

function freshTrade() {
  return { to: null, give: [], get: [], counterOf: null, preview: null };
}

// ---- Appearance ------------------------------------------------------------

function loadTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return ['light', 'dark'].includes(v) ? v : 'system';
  } catch (err) {
    return 'system';
  }
}

// 'system' follows the phone; 'light' and 'dark' override it through data-theme (see app.css)
function applyTheme(value) {
  S.theme = ['light', 'dark'].includes(value) ? value : 'system';
  const root = document.documentElement;
  if (S.theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', S.theme);
  try {
    if (S.theme === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, S.theme);
  } catch (err) {
    // Storage can be blocked; the choice still applies for this visit
  }
}

// ---- Network ---------------------------------------------------------------

async function api(method, path, body) {
  if (body === undefined && method !== 'GET') body = {};
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch (err) {
    throw new Error('Cannot reach the server. Check your connection and try again.');
  }
  let data = {};
  try { data = await res.json(); } catch (err) { data = {}; }
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    S.me = null;
    go('#/login');
  }
  if (!res.ok) {
    const e = new Error(data.error || `Request failed (${res.status})`);
    e.status = res.status;
    throw e;
  }
  return data;
}

function loadPlayers(id) {
  const q = new URLSearchParams({ status: 'free', limit: '80' });
  if (S.players.q.trim()) q.set('q', S.players.q.trim());
  if (S.players.pos !== 'ALL') q.set('pos', S.players.pos);
  if (S.players.group !== 'ALL') q.set('group', S.players.group);
  return api('GET', `/api/leagues/${id}/players?${q}`).then((r) => r.players);
}

function loadAvailable(id) {
  const q = new URLSearchParams({ pos: S.draft.dpos, q: S.draft.dq.trim() });
  return api('GET', `/api/leagues/${id}/draft/available?${q}`).then((r) => r.players);
}

// ---- Routing and screens --------------------------------------------------

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map((p) => {
    try { return decodeURIComponent(p); } catch (err) { return p; }
  });
  const [head, a, tab, tid] = parts;
  if (!head) return { name: 'root' };
  if (PLAIN_ROUTES.has(head)) return { name: head };
  if (head === 'l') return { name: 'league', id: Number(a), tab: tab || 'home', tid: tid ? Number(tid) : null };
  return { name: 'missing' };
}

function routeKey(r) {
  return [r.name, r.id || '', r.tab || '', r.tid || ''].join('|');
}

// Repaints the league screen when its status, week, team or alerts change
function signature(detail) {
  return `${detail.league.status}|${detail.week}|${detail.my_team_id}|${JSON.stringify(detail.alerts || [])}`;
}

const queueSig = (list) => JSON.stringify(list.map((q) => [q.player_id, q.taken]));
const chatSig = (messages) => JSON.stringify(messages.map((m) => [m.id, m.reactions]));

function draftSig(st) {
  return JSON.stringify([st.status, st.current_pick, st.on_clock && st.on_clock.id, st.deadline, st.picks.length]);
}

async function loadLeague(r) {
  if (!Number.isInteger(r.id) || r.id <= 0) return { kind: 'error', message: 'That league link is not valid.' };
  if (S.leagueId !== r.id) {
    S.leagueId = r.id;
    S.scoreWeek = null;
    S.openMatch = -1;
    S.openReact = null;
    S.trade = freshTrade();
    S.players = { q: '', pos: 'ALL', group: 'ALL' };
    S.draft = { dq: '', dpos: 'ALL' };
    S.chatLast = 0;
    S.chatSig = null;
  }
  const id = r.id;
  const tab = TABS.includes(r.tab) ? r.tab : 'home';
  const detail = await api('GET', `/api/leagues/${id}`);
  const myTeam = await api('GET', `/api/leagues/${id}/teams/${detail.my_team_id}`);
  const v = { kind: 'league', id, tab, detail, myTeam, team: null };
  S.leagueSig = signature(detail);
  S.liveDue = 0;

  switch (tab) {
    case 'home': {
      const [matchups, standings, activity, trades, rankings, awards, history] = await Promise.all([
        api('GET', `/api/leagues/${id}/matchups`),
        api('GET', `/api/leagues/${id}/standings`),
        api('GET', `/api/leagues/${id}/activity`),
        api('GET', `/api/leagues/${id}/trades`),
        api('GET', `/api/leagues/${id}/rankings`),
        api('GET', `/api/leagues/${id}/awards`),
        detail.league.status === 'complete' ? api('GET', `/api/leagues/${id}/history`) : null
      ]);
      if (matchups.live_games) S.liveDue = Date.now() + LIVE_REFRESH_MS;
      Object.assign(v, {
        matchups,
        standings: standings.standings,
        activity: activity.activity,
        trades: trades.trades,
        rankings: rankings.rankings,
        awards: awards.awards,
        results: history ? history.results : null
      });
      break;
    }
    case 'team':
      v.team = r.tid && r.tid !== detail.my_team_id ? await api('GET', `/api/leagues/${id}/teams/${r.tid}`) : myTeam;
      break;
    case 'players':
      v.players = await loadPlayers(id);
      break;
    case 'scores': {
      const q = S.scoreWeek ? `?week=${S.scoreWeek}` : '';
      v.scores = await api('GET', `/api/leagues/${id}/matchups${q}`);
      S.scoreWeek = v.scores.week;
      if (v.scores.live_games) S.liveDue = Date.now() + LIVE_REFRESH_MS;
      v.recap = (await api('GET', `/api/leagues/${id}/recap?week=${v.scores.week}`)).recap;
      break;
    }
    case 'draft': {
      const [draftRes, queueRes] = await Promise.all([
        api('GET', `/api/leagues/${id}/draft`),
        api('GET', `/api/leagues/${id}/draft/queue`)
      ]);
      v.draft = draftRes.draft;
      v.queue = queueRes.queue;
      v.available = v.draft.status === 'live' ? await loadAvailable(id) : [];
      S.draftSig = draftSig(v.draft);
      break;
    }
    case 'trades': {
      const tr = await api('GET', `/api/leagues/${id}/trades`);
      v.trades = tr.trades;
      v.tradeMeta = { open: tr.open, deadline_week: tr.deadline_week };
      v.partner = S.trade.to ? await api('GET', `/api/leagues/${id}/teams/${S.trade.to}`) : null;
      break;
    }
    case 'chat': {
      v.messages = (await api('GET', `/api/leagues/${id}/messages?after=0`)).messages;
      S.chatLast = v.messages.length ? v.messages[v.messages.length - 1].id : 0;
      S.chatSig = chatSig(v.messages);
      break;
    }
    default:
      break;
  }
  return v;
}

async function loadView(r) {
  switch (r.name) {
    case 'login':
    case 'signup':
      return { kind: 'auth', mode: r.name };
    case 'forgot':
      return { kind: 'auth', mode: 'forgot' };
    case 'recovery':
      return { kind: 'recovery', code: S.recoveryCode };
    case 'leagues':
      return { kind: 'leagues', leagues: (await api('GET', '/api/leagues')).leagues };
    case 'history':
      return { kind: 'history', seasons: (await api('GET', '/api/history')).seasons };
    case 'new':
      return { kind: 'new' };
    case 'join':
      return { kind: 'join' };
    case 'league':
      return loadLeague(r);
    default:
      return { kind: 'error', message: 'That page does not exist.' };
  }
}

function leagueBody(v) {
  const { detail } = v;
  switch (v.tab) {
    case 'home':
      return homeTab({
        detail,
        matchups: v.matchups,
        standings: v.standings,
        activity: v.activity,
        trades: v.trades,
        rankings: v.rankings,
        awards: v.awards,
        results: v.results
      });
    case 'team':
      return teamTab(v.team, detail);
    case 'players':
      return playersTab(detail, S.meta, S.players);
    case 'scores':
      return scoresTab(v.scores, detail, S.openMatch, v.recap);
    case 'draft':
      return draftTab(v.draft, detail, v.available || [], S.draft, v.queue || []);
    case 'trades':
      return tradesTab(v.trades, detail, S.trade, v.myTeam, v.partner, {
        open: v.tradeMeta.open,
        deadline_week: v.tradeMeta.deadline_week,
        preview: S.trade.preview
      });
    case 'chat':
      return chatTab(v.messages, S.openReact);
    case 'settings':
      return settingsTab(detail, S.meta || {});
    default:
      return emptyNote('This page is not available.');
  }
}

function appBar(back = false) {
  return `<header class="topbar">
    <div class="minw"><div class="appbar-title">Power Four Fantasy</div>
      <div class="meta">${S.me ? esc(S.me.name) : ''}</div></div>
    ${back ? '<a class="btn small" href="#/leagues">Leagues</a>' : ''}
  </header>`;
}

function buildView(v) {
  switch (v.kind) {
    case 'auth':
      return `<main id="main">${authPage(v.mode, v.error || '', S.meta || {})}</main>`;
    case 'leagues':
      return `${appBar()}<main id="main">${leaguesPage(v.leagues, S.meta, S.theme)}</main>`;
    case 'history':
      return `${appBar(true)}<main id="main">${historyPage(v.seasons)}</main>`;
    case 'recovery':
      return `${appBar(true)}<main id="main">${recoveryPage(v.code)}</main>`;
    case 'new':
      return `${appBar(true)}<main id="main">${newLeaguePage(S.meta.default_settings || DEFAULTS)}</main>`;
    case 'join':
      return `${appBar(true)}<main id="main">${joinPage()}</main>`;
    case 'league':
      return leagueShell(v.detail, v.tab, leagueBody(v));
    default:
      return `${appBar(true)}<main id="main">${errorPage(v.message)}</main>`;
  }
}

function afterMount(v) {
  if (!v || v.kind !== 'league') return;
  if (v.tab === 'players') {
    const el = document.getElementById('player-list');
    if (el) el.innerHTML = playerListHtml(v.players || [], v.detail);
  }
  if (v.tab === 'chat') {
    const log = document.getElementById('chat-log');
    if (log) log.scrollTop = log.scrollHeight;
  }
}

function paint(html, v, keepScroll) {
  const y = window.scrollY;
  const app = document.getElementById('app');
  app.setAttribute('aria-busy', 'false');
  app.innerHTML = html;
  window.scrollTo(0, keepScroll ? y : 0);
  afterMount(v);
}

// Rebuilds the current screen from data already loaded (no network)
function redraw() {
  if (!S.view) return;
  paint(buildView(S.view), S.view, true);
}

async function render() {
  const seq = ++renderSeq;
  const r = parseRoute();
  if (r.name === 'root') return go(S.me ? '#/leagues' : '#/login');
  if (!S.me && !AUTH_ROUTES.has(r.name)) return go('#/login');
  if (S.me && AUTH_ROUTES.has(r.name)) return go('#/leagues');
  if (r.name === 'recovery' && !S.recoveryCode) return go('#/leagues');
  if (r.name !== 'recovery') S.recoveryCode = null;
  const key = routeKey(r);
  const sameScreen = key === S.routeKey;
  let v;
  try {
    v = await loadView(r);
  } catch (err) {
    v = { kind: 'error', message: err.message };
  }
  if (seq !== renderSeq) return;
  S.routeKey = key;
  S.view = v;
  S.data = v.kind === 'league' ? v : null;
  paint(buildView(v), v, sameScreen);
}

// ---- Live updates ---------------------------------------------------------

// Replaces one chat message in place, so reactions do not jump the scroll position
function refreshMessage(mid) {
  const d = S.data;
  const m = d && d.messages ? d.messages.find((x) => x.id === mid) : null;
  const el = document.querySelector(`.msg[data-mid="${mid}"]`);
  if (!m || !el) return;
  el.outerHTML = chatLine(m, S.openReact);
}

// Fetches the newest 100 messages. Repaints only when a message or a reaction changed.
async function pollChat() {
  const d = S.data;
  if (!d || d.kind !== 'league' || d.tab !== 'chat' || busy.chat) return;
  busy.chat = true;
  try {
    const { messages } = await api('GET', `/api/leagues/${d.id}/messages?after=0`);
    const log = document.getElementById('chat-log');
    if (!log || S.data !== d) return;
    const sig = chatSig(messages);
    if (sig === S.chatSig) return;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    const prevLast = S.chatLast;
    d.messages = messages;
    S.chatSig = sig;
    S.chatLast = messages.length ? messages[messages.length - 1].id : 0;
    log.innerHTML = messages.length
      ? messages.map((m) => chatLine(m, S.openReact)).join('')
      : emptyNote('No messages yet. Say hello.');
    const mineNew = messages.some((m) => m.mine && m.id > prevLast);
    if (atBottom || mineNew) log.scrollTop = log.scrollHeight;
  } catch (err) {
    // Try again on the next tick
  } finally {
    busy.chat = false;
  }
}

// Redraws only the queue panel and the available list, so taps on them are not lost
function paintDraftLists() {
  const d = S.data;
  if (!d || d.kind !== 'league' || d.tab !== 'draft') return;
  const qp = document.getElementById('queue-panel');
  if (qp) qp.outerHTML = queuePanel(d.queue || []);
  const av = document.getElementById('draft-avail');
  if (av) av.innerHTML = draftList(d.available || [], d.draft, new Set((d.queue || []).map((q) => q.player_id)));
}

async function refreshAvailable() {
  const d = S.data;
  if (!d || d.kind !== 'league' || d.tab !== 'draft') return;
  const next = await loadAvailable(d.id);
  if (S.data !== d) return;
  d.available = next;
  paintDraftLists();
}

async function pollDraft() {
  const d = S.data;
  if (!d || d.kind !== 'league' || d.tab !== 'draft' || busy.draft) return;
  busy.draft = true;
  try {
    const state = (await api('GET', `/api/leagues/${d.id}/draft`)).draft;
    if (state.status !== d.draft.status) {
      busy.draft = false;
      return render();
    }
    d.draft = state;
    const sig = draftSig(state);
    if (sig !== S.draftSig) {
      S.draftSig = sig;
      const live = document.getElementById('draft-live');
      if (live) live.innerHTML = draftLive(state, d.detail.league);
    }
    if (state.status === 'live') {
      const [available, queue] = await Promise.all([
        loadAvailable(d.id),
        api('GET', `/api/leagues/${d.id}/draft/queue`).then((r) => r.queue)
      ]);
      if (S.data !== d) return;
      const changed = JSON.stringify(available) !== JSON.stringify(d.available) || queueSig(queue) !== queueSig(d.queue || []);
      d.available = available;
      d.queue = queue;
      if (changed) paintDraftLists();
    }
  } catch (err) {
    // Try again on the next tick
  } finally {
    busy.draft = false;
  }
}

async function pollLeague() {
  const d = S.data;
  if (!d || d.kind !== 'league' || busy.league) return;
  busy.league = true;
  try {
    const detail = await api('GET', `/api/leagues/${d.id}`);
    busy.league = false;
    if (signature(detail) !== S.leagueSig) return render();
    // While games are on, scores on screen are repainted about once a minute
    if (S.liveDue && Date.now() >= S.liveDue) return render();
  } catch (err) {
    // Try again on the next tick
  } finally {
    busy.league = false;
  }
}

function tickClocks() {
  const now = Date.now();
  document.querySelectorAll('.timer[data-deadline]').forEach((el) => {
    const left = Math.max(0, Math.round((Date.parse(el.dataset.deadline) - now) / 1000));
    el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    el.classList.toggle('urgent', left <= 10);
  });
}

// ---- Sheets, toasts, actions --------------------------------------------

function openSheet(html) {
  const root = document.getElementById('sheet-root');
  root.innerHTML = html;
  document.body.classList.add('sheet-open');
  const first = root.querySelector('.sheet button, .sheet a');
  if (first) first.focus({ preventScroll: true });
}

function closeSheet() {
  document.getElementById('sheet-root').innerHTML = '';
  document.body.classList.remove('sheet-open');
}

function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function run(task) {
  Promise.resolve().then(task).catch((err) => toast(err.message || 'Something went wrong'));
}

// Runs a change, then closes any sheet and reloads the screen
async function act(task, message) {
  try {
    await task();
    if (message) toast(message);
    closeSheet();
    await render();
    return true;
  } catch (err) {
    toast(err.message);
    return false;
  }
}

function debounced(key, fn, ms) {
  clearTimeout(timers[key]);
  timers[key] = setTimeout(() => run(fn), ms);
}

function nameOf(pid) {
  const d = S.data || {};
  const lists = [d.myTeam && d.myTeam.roster.map((r) => r.player), d.players, d.available];
  for (const list of lists) {
    const hit = list && list.find((p) => p.id === pid);
    if (hit) return hit.name;
  }
  return S.sheetName || 'that player';
}

// The FAAB bid typed on the player sheet (0 when the league is not FAAB)
function bidValue() {
  const el = document.getElementById('claim-bid');
  return el ? Math.max(0, Math.floor(Number(el.value) || 0)) : 0;
}

async function openPlayer(pid) {
  const d = S.data;
  if (!d || d.kind !== 'league') return;
  const [page, mine] = await Promise.all([
    api('GET', `/api/players/${enc(pid)}?league=${d.id}`),
    api('GET', `/api/leagues/${d.id}/teams/${d.detail.my_team_id}`)
  ]);
  if (S.data !== d) return;
  d.myTeam = mine;
  S.sheetName = page.player.name;
  openSheet(playerSheet({ data: page }, mine, d.detail));
}

function openDrop(sh) {
  openSheet(dropSheet(sh, S.data.myTeam));
}

async function quickAdd(pid) {
  const d = S.data;
  const name = nameOf(pid);
  if (d.myTeam.roster.length >= d.myTeam.capacity) return openDrop({ mode: 'add', pid, name });
  return act(() => api('POST', `/api/leagues/${d.id}/players/${enc(pid)}/add`, {}), `Added ${name}`);
}

// Moves one player to a slot. The server replaces the whole lineup, so this sends every starter.
// Locked starters keep their slot; a full slot swaps out its lowest-projected unlocked starter.
async function moveTo(pid, slot) {
  const d = S.data;
  const t = d.myTeam;
  const entry = t.roster.find((r) => r.player.id === pid);
  if (!entry) return;
  if (entry.locked) throw new Error(`${entry.player.name}'s game is underway, so he cannot move`);
  const from = entry.slot;
  if (slot === from) return closeSheet();
  const assign = {};
  for (const r of t.roster) if (r.slot !== BENCH) assign[r.player.id] = r.slot;
  delete assign[pid];
  if (slot !== BENCH) {
    const spec = t.slots.find((s) => s.key === slot);
    if (!spec) throw new Error('That slot does not exist');
    if (!spec.eligible.includes(entry.player.position)) throw new Error(`${entry.player.name} cannot play ${slot}`);
    const occupants = t.roster
      .filter((r) => r.slot === slot && r.player.id !== pid)
      .sort((a, b) => a.projection - b.projection);
    if (occupants.length >= spec.count) {
      const out = occupants.find((r) => !r.locked);
      if (!out) throw new Error(`Every ${slot} starter is locked this week`);
      const back = from !== BENCH ? t.slots.find((s) => s.key === from) : null;
      if (back && back.eligible.includes(out.player.position)) assign[out.player.id] = from;
      else delete assign[out.player.id];
    }
    assign[pid] = slot;
  }
  const label = slot === BENCH ? `${entry.player.name} moved to the bench` : `${entry.player.name} starts at ${slot}`;
  return act(() => api('PUT', `/api/leagues/${d.id}/teams/${t.team.id}/lineup`, { slots: assign }), label);
}

// Teams in draft order: set slots first, then by id
const orderedTeams = (teams) => teams.slice().sort((a, b) => (a.draft_slot || 99) - (b.draft_slot || 99) || a.id - b.id);

function queueIds() {
  return ((S.data && S.data.queue) || []).map((q) => q.player_id);
}

async function saveQueue(ids) {
  const d = S.data;
  const res = await api('PUT', `/api/leagues/${d.id}/draft/queue`, { player_ids: ids });
  d.queue = res.queue;
  paintDraftLists();
}

async function updatePreview() {
  const d = S.data;
  if (!S.trade.give.length && !S.trade.get.length) {
    S.trade.preview = null;
    return;
  }
  const q = new URLSearchParams({ give: S.trade.give.join(','), get: S.trade.get.join(',') });
  S.trade.preview = await api('GET', `/api/leagues/${d.id}/trades/preview?${q}`);
}

const ACTIONS = {
  'switch-auth': () => go(location.hash.startsWith('#/signup') ? '#/login' : '#/signup'),

  forgot: () => go('#/forgot'),

  'go-login': () => go('#/login'),

  logout: async () => {
    await api('POST', '/api/auth/logout', {}).catch(() => {});
    S.me = null;
    S.data = null;
    S.view = null;
    S.routeKey = null;
    S.recoveryCode = null;
    go('#/login');
  },

  theme: (el) => {
    applyTheme(el.dataset.v);
    redraw();
  },

  'release-member': async (el) => {
    const name = el.dataset.name || 'this member';
    const ok = window.confirm(`Remove ${name} from the league? Their team goes to a CPU, and their open trades and waiver claims close.`);
    if (!ok) return;
    await api('POST', `/api/leagues/${S.data.id}/teams/${el.dataset.tid}/release`, {});
    toast(`${name} was removed`);
    await render();
  },

  'copy-code': async (el) => {
    const code = el.dataset.code;
    const label = el.dataset.label || 'Copied';
    try {
      await navigator.clipboard.writeText(code);
      toast(label);
    } catch (err) {
      toast(`${label.replace(' copied', '')}: ${code}`);
    }
  },

  'start-draft': async () => {
    const id = S.data.id;
    await api('POST', `/api/leagues/${id}/draft/start`, {});
    toast('Draft started');
    go(`#/l/${id}/draft`);
  },

  'order-move': (el) => {
    const d = S.data;
    const teams = orderedTeams(d.detail.teams);
    const i = teams.findIndex((t) => t.id === Number(el.dataset.tid));
    const j = i + Number(el.dataset.dir);
    if (i < 0 || j < 0 || j >= teams.length) return;
    [teams[i], teams[j]] = [teams[j], teams[i]];
    return act(() => api('PUT', `/api/leagues/${d.id}/draft/order`, { team_ids: teams.map((t) => t.id) }));
  },

  'order-random': () => act(() => api('POST', `/api/leagues/${S.data.id}/draft/order/random`, {}), 'Draft order shuffled'),

  'draft-pick': (el) => act(() => api('POST', `/api/leagues/${S.data.id}/draft/pick`, { player_id: el.dataset.pid }), 'Pick made'),

  'draft-auto': () => {
    const best = (S.data.available || [])[0];
    if (!best) return toast('No players left to pick');
    return act(() => api('POST', `/api/leagues/${S.data.id}/draft/pick`, { player_id: best.id }), `Picked ${best.name}`);
  },

  'queue-add': (el) => {
    const ids = queueIds();
    const pid = el.dataset.pid;
    if (ids.includes(pid)) return;
    if (ids.length >= 60) return toast('Your queue holds up to 60 players');
    return saveQueue([...ids, pid]);
  },

  'queue-remove': (el) => saveQueue(queueIds().filter((id) => id !== el.dataset.pid)),

  'queue-move': (el) => {
    const ids = queueIds();
    const i = ids.indexOf(el.dataset.pid);
    const j = i + Number(el.dataset.dir);
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    return saveQueue(ids);
  },

  open: (el) => openPlayer(el.dataset.pid),

  close: () => closeSheet(),

  'quick-add': (el) => quickAdd(el.dataset.pid),

  'add-drop': (el) => {
    const pid = el.dataset.pid;
    const name = nameOf(pid);
    return act(() => api('POST', `/api/leagues/${S.data.id}/players/${enc(pid)}/add`, { drop_player_id: el.dataset.drop }), `Added ${name}`);
  },

  claim: (el) => {
    const d = S.data;
    const pid = el.dataset.pid;
    const name = nameOf(pid);
    const bid = bidValue();
    if (d.myTeam.roster.length >= d.myTeam.capacity) return openDrop({ mode: 'claim', pid, name, bid });
    return act(() => api('POST', `/api/leagues/${d.id}/players/${enc(pid)}/claim`, { bid }), `Claim placed on ${name}`);
  },

  'claim-drop': (el) => act(
    () => api('POST', `/api/leagues/${S.data.id}/players/${enc(el.dataset.pid)}/claim`, { drop_player_id: el.dataset.drop, bid: Number(el.dataset.bid || 0) }),
    'Claim placed'
  ),

  'cancel-claim': (el) => act(() => api('DELETE', `/api/leagues/${S.data.id}/claims/${el.dataset.cid}`), 'Claim cancelled'),

  drop: (el) => {
    const pid = el.dataset.pid;
    const name = nameOf(pid);
    return act(() => api('POST', `/api/leagues/${S.data.id}/drop/${enc(pid)}`, {}), `Dropped ${name}`);
  },

  move: (el) => moveTo(el.dataset.pid, el.dataset.slot),

  'auto-lineup': () => act(() => api('POST', `/api/leagues/${S.data.id}/teams/${S.data.detail.my_team_id}/auto-lineup`, {}), 'Best lineup set'),

  'trade-to': async (el) => {
    const d = S.data;
    const tid = Number(el.dataset.tid);
    S.trade = freshTrade();
    S.trade.to = tid;
    d.partner = await api('GET', `/api/leagues/${d.id}/teams/${tid}`);
    redraw();
  },

  'trade-toggle': async (el) => {
    const list = el.dataset.side === 'give' ? S.trade.give : S.trade.get;
    const pid = el.dataset.pid;
    const i = list.indexOf(pid);
    if (i >= 0) list.splice(i, 1);
    else if (list.length < 6) list.push(pid);
    else return toast('Up to 6 players per side');
    await updatePreview();
    redraw();
  },

  // Counter-offer: starts from the offer received, with the sides swapped, so the user edits it
  'trade-counter': async (el) => {
    const d = S.data;
    const tid = Number(el.dataset.tid);
    const trade = (d.trades || []).find((t) => t.id === tid);
    if (!trade) return toast('That offer is no longer open');
    S.trade = freshTrade();
    S.trade.to = trade.from.id;
    S.trade.give = trade.get.map((p) => p.id);
    S.trade.get = trade.give.map((p) => p.id);
    S.trade.counterOf = tid;
    d.partner = await api('GET', `/api/leagues/${d.id}/teams/${trade.from.id}`);
    await updatePreview();
    redraw();
  },

  'trade-propose': () => {
    const counter = !!S.trade.counterOf;
    return act(async () => {
      const d = S.data;
      if (counter) {
        await api('POST', `/api/leagues/${d.id}/trades/${S.trade.counterOf}/counter`, { give: S.trade.give, get: S.trade.get });
      } else {
        await api('POST', `/api/leagues/${d.id}/trades`, { to_team_id: S.trade.to, give: S.trade.give, get: S.trade.get });
      }
      S.trade = freshTrade();
    }, counter ? 'Counter-offer sent' : 'Trade offered');
  },

  'trade-accept': (el) => act(() => api('POST', `/api/leagues/${S.data.id}/trades/${el.dataset.tid}/accept`, {}), 'Trade accepted'),
  'trade-decline': (el) => act(() => api('POST', `/api/leagues/${S.data.id}/trades/${el.dataset.tid}/decline`, {}), 'Trade declined'),
  'trade-cancel': (el) => act(() => api('POST', `/api/leagues/${S.data.id}/trades/${el.dataset.tid}/cancel`, {}), 'Trade cancelled'),

  week: (el) => {
    S.scoreWeek = S.data.scores.week + Number(el.dataset.d);
    S.openMatch = -1;
    return render();
  },

  match: (el) => {
    const i = Number(el.dataset.i);
    S.openMatch = S.openMatch === i ? -1 : i;
    redraw();
  },

  pos: async (el) => setPlayerFilter('pos', el.dataset.v),

  group: async (el) => setPlayerFilter('group', el.dataset.v),

  dpos: async (el) => {
    S.draft.dpos = el.dataset.v;
    redraw();
    await refreshAvailable();
  },

  'react-open': (el) => {
    const mid = Number(el.dataset.mid);
    const prev = S.openReact;
    S.openReact = prev === mid ? null : mid;
    if (prev && prev !== mid) refreshMessage(prev);
    refreshMessage(mid);
    const first = document.querySelector(`.msg[data-mid="${mid}"] .picker .react`);
    if (first && S.openReact === mid) first.focus({ preventScroll: true });
  },

  react: async (el) => {
    const d = S.data;
    const mid = Number(el.dataset.mid);
    const res = await api('POST', `/api/leagues/${d.id}/messages/${mid}/react`, { emoji: el.dataset.emoji });
    const m = (d.messages || []).find((x) => x.id === mid);
    if (m) m.reactions = res.reactions;
    S.chatSig = chatSig(d.messages || []);
    S.openReact = null;
    refreshMessage(mid);
  }
};

async function setPlayerFilter(key, value) {
  const d = S.data;
  if (!d || d.kind !== 'league') return;
  S.players[key] = value;
  d.players = await loadPlayers(d.id);
  redraw();
}

async function refreshPlayers() {
  const d = S.data;
  if (!d || d.kind !== 'league' || d.tab !== 'players') return;
  d.players = await loadPlayers(d.id);
  const el = document.getElementById('player-list');
  if (el) el.innerHTML = playerListHtml(d.players, d.detail);
}

// ---- Forms -------------------------------------------------------------------

// League rules as the server takes them. Checkboxes arrive as 'on' or are absent.
function rulesFrom(d) {
  return {
    format: d.format,
    regular_weeks: Number(d.regular_weeks),
    playoff_teams: Number(d.playoff_teams),
    waiver_mode: d.waiver_mode,
    faab_budget: Number(d.faab_budget),
    trade_deadline_week: Number(d.trade_deadline_week),
    best_ball: d.best_ball === 'on',
    pick_seconds: Number(d.pick_seconds)
  };
}

const FORMS = {
  auth: async (form, d) => {
    if (form.dataset.mode === 'signup') {
      const res = await api('POST', '/api/auth/signup', { name: d.name, email: d.email, password: d.password });
      S.me = res.user;
      S.recoveryCode = res.recovery_code;
      return go('#/recovery');
    }
    const res = await api('POST', '/api/auth/login', { email: d.email, password: d.password });
    S.me = res.user;
    go('#/leagues');
  },

  reset: async (form, d) => {
    const res = await api('POST', '/api/auth/reset', { email: d.email, recovery_code: d.recovery_code, password: d.password });
    S.me = res.user;
    S.recoveryCode = res.recovery_code;
    go('#/recovery');
  },

  'recovery-code': async (form, d) => {
    const res = await api('POST', '/api/me/recovery-code', { password: d.password });
    S.recoveryCode = res.recovery_code;
    go('#/recovery');
  },

  'new-league': async (form, d) => {
    const res = await api('POST', '/api/leagues', {
      name: d.name,
      team_count: Number(d.team_count),
      ...rulesFrom(d)
    });
    toast('League created');
    go(`#/l/${res.league.id}/home`);
  },

  join: async (form, d) => {
    const res = await api('POST', '/api/leagues/join', { code: d.code });
    toast(res.joined ? `Joined ${res.league.name}` : `You are already in ${res.league.name}`);
    go(`#/l/${res.league.id}/home`);
  },

  'rename-team': async (form, d) => {
    const L = S.data;
    await api('PATCH', `/api/leagues/${L.id}/teams/${L.detail.my_team_id}`, { name: d.name });
    toast('Team renamed');
    await render();
  },

  'league-settings': async (form, d) => {
    const scoring = {};
    for (const [key] of SCORING_FIELDS) scoring[key] = Number(d[`scoring_${key}`]);
    await api('PATCH', `/api/leagues/${S.data.id}`, { name: d.name, ...rulesFrom(d), scoring });
    toast('Settings saved');
    await render();
  },

  chat: async (form, d) => {
    const body = (d.body || '').trim();
    if (!body) return;
    await api('POST', `/api/leagues/${S.data.id}/messages`, { body });
    form.reset();
    await pollChat();
  },

  feedback: async (form, d) => {
    const body = (d.body || '').trim();
    const leagueId = S.data ? S.data.id : null;
    await api('POST', '/api/feedback', { body, league_id: leagueId });
    form.reset();
    toast('Thanks. Your message is saved.');
  }
};

function onSubmit(e) {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const handler = FORMS[form.dataset.form];
  if (!handler) return;
  const data = Object.fromEntries(new FormData(form));
  const submit = form.querySelector('button[type="submit"]');
  const error = form.querySelector('.form-error');
  if (error) error.textContent = '';
  if (submit) submit.disabled = true;
  Promise.resolve()
    .then(() => handler(form, data))
    .catch((err) => {
      if (error) error.textContent = err.message;
      else toast(err.message);
    })
    .finally(() => {
      if (submit) submit.disabled = false;
    });
}

// ---- Events -----------------------------------------------------------------

function onClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  run(() => fn(el));
}

function onInput(e) {
  const el = e.target;
  if (!(el instanceof HTMLInputElement) || !el.dataset.input) return;
  if (el.dataset.input === 'q') {
    S.players.q = el.value;
    debounced('players', refreshPlayers, 250);
  } else if (el.dataset.input === 'dq') {
    S.draft.dq = el.value;
    debounced('draft', refreshAvailable, 250);
  }
}

function onKeydown(e) {
  if (e.key === 'Escape') {
    if (document.getElementById('sheet-root').innerHTML) closeSheet();
    return;
  }
  const t = e.target;
  if ((e.key === 'Enter' || e.key === ' ') && t instanceof Element && t.matches('[role="button"][data-act], [role="checkbox"][data-act]')) {
    e.preventDefault();
    t.click();
  }
}

// ---- Start ------------------------------------------------------------------

async function boot() {
  applyTheme(loadTheme());
  try {
    S.meta = await api('GET', '/api/meta');
  } catch (err) {
    S.meta = { season: 2026, current_week: 1, groups: [], default_settings: DEFAULTS };
  }
  try {
    S.me = (await api('GET', '/api/me')).user;
  } catch (err) {
    S.me = null;
  }
  window.addEventListener('hashchange', render);
  document.addEventListener('click', onClick);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('input', onInput);
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollLeague(); });
  setInterval(tickClocks, 1000);
  setInterval(() => { pollDraft(); pollChat(); }, 2500);
  setInterval(pollLeague, 8000);
  if (!location.hash) history.replaceState(null, '', '#/');
  render();
  registerServiceWorker();
}

// Lets the phone install the app to the home screen and keep the app shell offline.
// Live league data always comes from the network.
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // Installing is optional; the app works in the browser without it
  });
}

boot();
