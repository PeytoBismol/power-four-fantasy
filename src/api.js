'use strict';

// HTTP API. Handlers are synchronous and each request runs inside one SQLite transaction
// (see handleApi), so a thrown ApiError rolls back everything the request touched.

const crypto = require('crypto');
const { SEASON, GROUPS, FANTASY_POSITIONS, SLOTS, SLOT_ELIGIBLE, DEFAULT_SETTINGS, BENCH } = require('./config');
const { ApiError, requireString, readJson, hashPassword, verifyPassword, randomToken, nowIso, round1 } = require('./util');
const { tx, getMeta } = require('./db');
const { scoringFor, playerPoints, defensePoints } = require('./scoring');
const { createLimits } = require('./limiter');
const season = require('./season');
const L = require('./league');
const flow = require('./flow');
const draft = require('./draft');
const { alertsFor } = require('./alerts');

const SESSION_DAYS = 30;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const FEEDBACK_PER_DAY = 5;
const LOG_ORDER = "CASE season_type WHEN 'regular' THEN 0 ELSE 1 END, week";
const REACTIONS = ['👍', '🔥', '😂', '😮', '🏈', '👎'];
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEFAULT_LIMITS = createLimits();

// ---- Sessions ----------------------------------------------------------------

function sessionUser(db, token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.name, u.email, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).get(token);
  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return { id: row.id, name: row.name, email: row.email };
}

// Bearer header first (scripts and tests), then the session cookie (the web app)
function tokenFrom(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)pf_session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function createSession(db, userId) {
  const token = randomToken(32);
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, new Date(now).toISOString(), new Date(now + SESSION_DAYS * 864e5).toISOString());
  return { token, maxAge: SESSION_DAYS * 86400 };
}

// ---- Recovery codes ------------------------------------------------------------
// Shown once at sign-up (and when regenerated). Stored only as a hash. Format: XXXX-XXXX-XXXX-XXXX.

function newRecoveryCode() {
  const bytes = crypto.randomBytes(16);
  let raw = '';
  for (const b of bytes) raw += RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length];
  return raw.match(/.{4}/g).join('-');
}

function normalizeCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function ipOf(req) {
  return String(req.headers['fly-client-ip'] || (req.socket && req.socket.remoteAddress) || 'unknown');
}

// Refuses the request while either limiter is blocking the key
function guard(checks) {
  for (const [limiter, key, message] of checks) {
    const wait = limiter.blocked(key);
    if (wait) {
      const minutes = Math.max(1, Math.ceil(wait / 60));
      throw new ApiError(429, `${message} Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`);
    }
  }
}

// ---- Helpers -----------------------------------------------------------------

function me(ctx) {
  if (!ctx.user) throw new ApiError(401, 'Sign in to continue');
  return ctx.user;
}

function idParam(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new ApiError(404, 'Not found');
  return n;
}

function leagueOf(ctx) {
  return L.getLeague(ctx.db, idParam(ctx.params.id));
}

function summarize(db, league, user) {
  const mine = L.myTeamOf(db, league, user.id);
  return {
    id: league.id,
    name: league.name,
    season: league.season,
    status: league.status,
    invite_code: league.invite_code,
    commissioner: league.commissioner_id === user.id,
    settings: league.settings,
    start_week: league.start_week,
    my_team: mine ? { id: mine.id, name: mine.name } : null
  };
}

function weekList(league, liveWeek) {
  const out = [];
  for (let w = league.start_week || 1; w <= flow.finalWeekOf(league); w++) {
    out.push({ week: w, status: season.weekStatus(w, liveWeek), playoff: w > league.settings.regular_weeks });
  }
  return out;
}

function isActive(league) {
  return league.status === 'season' || league.status === 'complete';
}

function statLine(pos, g) {
  if (!g.pass_att && !g.rush_att && !g.rec && !g.fga && !g.xpm) return 'Did not play';
  if (pos === 'QB') {
    const rush = g.rush_att ? `, ${g.rush_att} car, ${g.rush_yd} rush yd` : '';
    return `${g.pass_cmp}/${g.pass_att}, ${g.pass_yd} yd, ${g.pass_td} TD${g.pass_int ? `, ${g.pass_int} INT` : ''}${rush}`;
  }
  if (pos === 'K') return `${g.fgm}/${g.fga} FG, ${g.xpm} XP`;
  if (pos === 'RB') return `${g.rush_att} car, ${g.rush_yd} yd, ${g.rush_td} TD${g.rec ? `, ${g.rec} rec, ${g.rec_yd} yd` : ''}`;
  return `${g.rec} rec, ${g.rec_yd} yd, ${g.rec_td} TD`;
}

function playerLog(db, p, scoring) {
  return db.prepare(`SELECT * FROM player_games WHERE player_id = ? AND season = ? ORDER BY ${LOG_ORDER}`)
    .all(p.id, SEASON)
    .map((g) => ({
      week: g.week,
      season_type: g.season_type,
      line: statLine(p.position, g),
      points: round1(playerPoints(g, scoring))
    }));
}

function defenseLog(db, p, scoring) {
  return db.prepare(`SELECT * FROM defense_games WHERE team_id = ? AND season = ? ORDER BY ${LOG_ORDER}`)
    .all(p.team_id, SEASON)
    .map((g) => ({
      week: g.week,
      season_type: g.season_type,
      line: `${g.sacks} sacks · ${g.def_int} INT · ${g.def_td} TD · ${g.points_allowed ?? '?'} pts allowed`,
      points: round1(defensePoints(g, scoring))
    }));
}

// Reactions for a set of messages: { message_id: [{ emoji, count, mine }] }
function reactionsFor(db, messageIds, userId) {
  const out = {};
  if (!messageIds.length) return out;
  const rows = db.prepare(`
    SELECT message_id, emoji, COUNT(*) AS n, MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS mine
    FROM message_reactions WHERE message_id IN (${messageIds.map(() => '?').join(',')})
    GROUP BY message_id, emoji ORDER BY emoji
  `).all(userId, ...messageIds);
  for (const r of rows) {
    (out[r.message_id] = out[r.message_id] || []).push({ emoji: r.emoji, count: r.n, mine: !!r.mine });
  }
  return out;
}

// Trade verdicts are read from the proposer's side. Value is in the same points the draft ranks by.
function tradeVerdict(valueChange) {
  if (valueChange > 5) return 'This favors you';
  if (valueChange < -5) return 'This favors them';
  return 'About even';
}

function mapResult(r) {
  return {
    league_id: r.league_id,
    league_name: r.league_name,
    season: r.season,
    team_name: r.team_name,
    owner: r.owner,
    place: r.place,
    wins: r.wins,
    losses: r.losses,
    points_for: round1(r.points_for),
    champion: !!r.champion,
    finished_at: r.finished_at
  };
}

// ---- Routes ------------------------------------------------------------------

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
}

// Auth

route('POST', '/api/auth/signup', (ctx) => {
  const b = ctx.body;
  const name = requireString(b.name, 'Name', { max: 40 });
  const email = requireString(b.email, 'Email', { max: 120 }).toLowerCase();
  if (!EMAIL_RE.test(email)) throw new ApiError(400, 'Enter a valid email address');
  const password = String(b.password || '');
  if (password.length < 8 || password.length > 200) throw new ApiError(400, 'Password must be 8 to 200 characters');
  if (ctx.db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    throw new ApiError(409, 'An account already uses that email');
  }
  const recovery = newRecoveryCode();
  const info = ctx.db.prepare('INSERT INTO users (email, name, password_hash, recovery_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(email, name, hashPassword(password), hashPassword(normalizeCode(recovery)), nowIso());
  const user = { id: Number(info.lastInsertRowid), name, email };
  return { user, session: createSession(ctx.db, user.id), recovery_code: recovery };
});

route('POST', '/api/auth/login', (ctx) => {
  const email = String(ctx.body.email || '').trim().toLowerCase();
  const ip = ipOf(ctx.req);
  guard([
    [ctx.limits.loginEmail, email, 'Too many sign-in attempts for this email.'],
    [ctx.limits.loginIp, ip, 'Too many sign-in attempts from this network.']
  ]);
  const row = ctx.db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!row || !verifyPassword(String(ctx.body.password || ''), row.password_hash)) {
    ctx.limits.loginEmail.fail(email);
    ctx.limits.loginIp.fail(ip);
    throw new ApiError(401, 'Email or password is incorrect');
  }
  ctx.limits.loginEmail.clear(email);
  return { user: { id: row.id, name: row.name, email: row.email }, session: createSession(ctx.db, row.id) };
});

// Forgot password: email + recovery code + new password. Signs the user in and issues a new recovery code.
route('POST', '/api/auth/reset', (ctx) => {
  const email = String(ctx.body.email || '').trim().toLowerCase();
  const ip = ipOf(ctx.req);
  guard([
    [ctx.limits.resetEmail, email, 'Too many recovery attempts for this email.'],
    [ctx.limits.resetIp, ip, 'Too many recovery attempts from this network.']
  ]);
  const password = String(ctx.body.password || '');
  if (password.length < 8 || password.length > 200) throw new ApiError(400, 'Password must be 8 to 200 characters');
  const row = ctx.db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const codeOk = row && row.recovery_hash && verifyPassword(normalizeCode(ctx.body.recovery_code), row.recovery_hash);
  if (!codeOk) {
    ctx.limits.resetEmail.fail(email);
    ctx.limits.resetIp.fail(ip);
    throw new ApiError(401, 'That email and recovery code do not match');
  }
  const recovery = newRecoveryCode();
  ctx.db.prepare('UPDATE users SET password_hash = ?, recovery_hash = ? WHERE id = ?')
    .run(hashPassword(password), hashPassword(normalizeCode(recovery)), row.id);
  ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
  ctx.limits.resetEmail.clear(email);
  return {
    user: { id: row.id, name: row.name, email: row.email },
    session: createSession(ctx.db, row.id),
    recovery_code: recovery
  };
});

// Replaces the recovery code. Needs the current password so a stolen session cannot do it alone.
route('POST', '/api/me/recovery-code', (ctx) => {
  const user = me(ctx);
  const row = ctx.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
  if (!row || !verifyPassword(String(ctx.body.password || ''), row.password_hash)) {
    throw new ApiError(403, 'Enter your current password to get a new recovery code');
  }
  const recovery = newRecoveryCode();
  ctx.db.prepare('UPDATE users SET recovery_hash = ? WHERE id = ?').run(hashPassword(normalizeCode(recovery)), user.id);
  return { recovery_code: recovery };
});

route('POST', '/api/auth/logout', (ctx) => {
  if (ctx.token) ctx.db.prepare('DELETE FROM sessions WHERE token = ?').run(ctx.token);
  return { logout: true };
});

route('GET', '/api/me', (ctx) => ({ user: ctx.user }));

// Reference data

// The support address comes from SUPPORT_EMAIL on the server. There is no built-in default.
function supportEmail() {
  const value = String(process.env.SUPPORT_EMAIL || '').trim();
  return EMAIL_RE.test(value) ? value : null;
}

route('GET', '/api/meta', (ctx) => ({
  season: SEASON,
  current_week: season.currentWeek(ctx.db),
  groups: GROUPS.map((g) => ({ key: g.key, label: g.label })),
  positions: FANTASY_POSITIONS,
  slots: SLOTS.map((s) => ({ key: s, eligible: SLOT_ELIGIBLE[s] })),
  default_settings: DEFAULT_SETTINGS,
  reactions: REACTIONS,
  support_email: supportEmail(),
  data: {
    source: getMeta(ctx.db, 'data_source', 'none'),
    last_ingest_at: getMeta(ctx.db, 'last_ingest_at', null),
    last_backup_at: getMeta(ctx.db, 'last_backup_at', null),
    attribution: 'Stats and team data: CollegeFootballData.com'
  }
}));

route('GET', '/api/teams', (ctx) => ({
  teams: ctx.db.prepare('SELECT id, school, mascot, abbreviation, conference, group_key, color, alt_color FROM teams ORDER BY school').all()
}));

// Leagues

route('GET', '/api/leagues', (ctx) => {
  const user = me(ctx);
  const rows = ctx.db.prepare(`
    SELECT l.*, ft.id AS my_team_id, ft.name AS my_team_name,
      (SELECT COUNT(*) FROM fantasy_teams x WHERE x.league_id = l.id AND x.is_cpu = 0) AS members
    FROM leagues l JOIN fantasy_teams ft ON ft.league_id = l.id AND ft.user_id = ?
    ORDER BY l.created_at DESC
  `).all(user.id);
  return {
    leagues: rows.map((r) => ({
      id: r.id,
      name: r.name,
      season: r.season,
      status: r.status,
      team_count: JSON.parse(r.settings).team_count,
      members: r.members,
      my_team: { id: r.my_team_id, name: r.my_team_name },
      commissioner: r.commissioner_id === user.id
    }))
  };
});

route('POST', '/api/leagues', (ctx) => {
  const user = me(ctx);
  return { league: summarize(ctx.db, L.createLeague(ctx.db, user, ctx.body), user) };
});

route('POST', '/api/leagues/join', (ctx) => {
  const user = me(ctx);
  const { league, team, joined } = L.joinLeague(ctx.db, user, ctx.body.code);
  return { league: summarize(ctx.db, league, user), team: { id: team.id, name: team.name }, joined };
});

route('GET', '/api/leagues/:id', (ctx) => {
  const user = me(ctx);
  const league = leagueOf(ctx);
  const mine = L.requireMember(ctx.db, league, user.id);
  const week = season.currentWeek(ctx.db);
  const teams = L.teamsOf(ctx.db, league.id).map((t) => ({
    ...flow.teamSummary(ctx.db, t),
    roster_count: L.rosterCount(ctx.db, t.id),
    is_me: t.id === mine.id
  }));
  return {
    league: summarize(ctx.db, league, user),
    week,
    final_week: flow.finalWeekOf(league),
    weeks: weekList(league, week),
    teams,
    my_team_id: mine.id,
    capacity: L.capacity(league),
    alerts: alertsFor(ctx.db, league, mine, user)
  };
});

route('PATCH', '/api/leagues/:id', (ctx) => {
  const user = me(ctx);
  const league = leagueOf(ctx);
  L.requireMember(ctx.db, league, user.id);
  return { league: summarize(ctx.db, L.updateSettings(ctx.db, league, user, ctx.body), user) };
});

route('PATCH', '/api/leagues/:id/teams/:teamId', (ctx) => {
  const user = me(ctx);
  const league = leagueOf(ctx);
  const team = L.teamOf(ctx.db, league, idParam(ctx.params.teamId));
  L.renameTeam(ctx.db, league, team, user, ctx.body.name);
  return { team: { id: team.id, name: String(ctx.body.name).trim() } };
});

// Commissioner removes a member. Their team goes to a CPU. During a live draft the CPU picks run straight away.
route('POST', '/api/leagues/:id/teams/:teamId/release', (ctx) => {
  const user = me(ctx);
  const league = leagueOf(ctx);
  const team = L.teamOf(ctx.db, league, idParam(ctx.params.teamId));
  L.requireCommissioner(league, user);
  L.releaseMember(ctx.db, league, user, team);
  if (league.status === 'drafting') draft.processDraft(ctx.db, L.getLeague(ctx.db, league.id));
  return { ok: true };
});

// Draft

route('POST', '/api/leagues/:id/draft/start', (ctx) => {
  const user = me(ctx);
  draft.startDraft(ctx.db, leagueOf(ctx), user);
  return { ok: true };
});

route('PUT', '/api/leagues/:id/draft/order', (ctx) => {
  const user = me(ctx);
  draft.setDraftOrder(ctx.db, leagueOf(ctx), user, ctx.body.team_ids);
  return { ok: true };
});

route('POST', '/api/leagues/:id/draft/order/random', (ctx) => {
  const user = me(ctx);
  draft.randomizeDraftOrder(ctx.db, leagueOf(ctx), user);
  return { ok: true };
});

route('GET', '/api/leagues/:id/draft', (ctx) => {
  const user = me(ctx);
  const league = leagueOf(ctx);
  L.requireMember(ctx.db, league, user.id);
  return { draft: draft.draftState(ctx.db, league, user.id) };
});

route('GET', '/api/leagues/:id/draft/available', (ctx) => {
  const user = me(ctx);
  const league = leagueOf(ctx);
  L.requireMember(ctx.db, league, user.id);
  const week = season.currentWeek(ctx.db);
  const taken = L.ownerMap(ctx.db, league.id);
  const pos = ctx.query.get('pos');
  const q = (ctx.query.get('q') || '').trim().toLowerCase();
  const out = [];
  // rank is the player's place in the whole pool, so it stays the same while filters change
  draft.draftRanking(ctx.db, league, week).forEach((c, i) => {
    if (taken.has(c.id)) return;
    if (pos && pos !== 'ALL' && c.position !== pos) return;
    if (out.length >= 60) return;
    const p = L.playerRow(ctx.db, c.id);
    if (q && !p.name.toLowerCase().includes(q) && !p.school.toLowerCase().includes(q)) return;
    out.push({ ...L.playerCard(p), rank: i + 1, projection: round1(c.projection), value: round1(c.value) });
  });
  return { players: out };
});

route('GET', '/api/leagues/:id/draft/queue', (ctx) => {
  const user = me(ctx);
  const league = leagueOf(ctx);
  const team = L.requireMember(ctx.db, league, user.id);
  return { queue: draft.getQueue(ctx.db, league, team) };
});

route('PUT', '/api/leagues/:id/draft/queue', (ctx) => {
  const user = me(ctx);
  const league = leagueOf(ctx);
  const team = L.requireMember(ctx.db, league, user.id);
  draft.setQueue(ctx.db, league, team, ctx.body.player_ids);
  return { queue: draft.getQueue(ctx.db, league, team) };
});

route('POST', '/api/leagues/:id/draft/pick', (ctx) => {
  const user = me(ctx);
  const league = leagueOf(ctx);
  L.requireMember(ctx.db, league, user.id);
  draft.makePick(ctx.db, league, user, String(ctx.body.player_id || ''));
  return { ok: true };
});

// Teams and lineups

route('GET', '/api/leagues/:id/teams/:teamId', (ctx) => {
  const user = me(ctx);
  const league = leagueOf(ctx);
  L.requireMember(ctx.db, league, user.id);
  const team = L.teamOf(ctx.db, league, idParam(ctx.params.teamId));
  const week = season.currentWeek(ctx.db);
  const pmap = season.weekPoints(ctx.db, league.season, league.settings, week);
  const proj = season.projectionMap(ctx.db, league.season, league.settings, week);
  const kickoffs = L.kickoffsForWeek(ctx.db, league.season, week);
  const rawRoster = L.rosterRows(ctx.db, team.id);
  const roster = rawRoster.map((r) => {
    const game = kickoffs.get(r.team_id) || null;
    return {
      player: L.playerCard(L.playerRow(ctx.db, r.player_id)),
      slot: r.slot,
      projection: proj.get(r.player_id) || 0,
      points: pmap.get(r.player_id) || 0,
      locked: L.hasKickedOff(game),
      game: game ? { start: game.start, completed: game.completed } : null
    };
  });
  const starters = roster.filter((r) => r.slot !== BENCH);
  const isMine = team.user_id === user.id;
  const claims = ctx.db.prepare(`
    SELECT id, player_id, drop_player_id, status, note, week, bid
    FROM waiver_claims WHERE team_id = ? ORDER BY id DESC LIMIT 25
  `).all(team.id).map((c) => ({
    id: c.id,
    status: c.status,
    note: c.note,
    week: c.week,
    bid: c.bid,
    player: L.playerCard(L.playerRow(ctx.db, c.player_id)),
    drop: c.drop_player_id ? L.playerCard(L.playerRow(ctx.db, c.drop_player_id)) : null
  }));
  return {
    team: flow.teamSummary(ctx.db, team),
    is_mine: isMine,
    week,
    roster,
    slots: SLOTS.map((s) => ({ key: s, count: league.settings.roster[s], eligible: SLOT_ELIGIBLE[s] })),
    bench_size: league.settings.roster[BENCH],
    capacity: L.capacity(league),
    projected_total: round1(starters.reduce((a, r) => a + r.projection, 0)),
    points_total: round1(starters.reduce((a, r) => a + r.points, 0)),
    warnings: isMine && league.status === 'season' ? L.lineupWarnings(ctx.db, league, team, week) : [],
    faab: team.faab,
    waiver_mode: league.settings.waiver_mode,
    best_ball: league.settings.best_ball,
    claims,
    scoring: scoringFor(league.settings)
  };
});

route('PUT', '/api/leagues/:id/teams/:teamId/lineup', (ctx) => {
  const user = me(ctx);
  const league = leagueOf(ctx);
  const team = L.teamOf(ctx.db, league, idParam(ctx.params.teamId));
  if (team.user_id !== user.id) throw new ApiError(403, 'You can only set your own lineup');
  L.setLineup(ctx.db, league, team, ctx.body.slots || {});
  return { ok: true };
});

route('POST', '/api/leagues/:id/teams/:teamId/auto-lineup', (ctx) => {
  const user = me(ctx);
  const league = leagueOf(ctx);
  const team = L.teamOf(ctx.db, league, idParam(ctx.params.teamId));
  if (team.user_id !== user.id) throw new ApiError(403, 'You can only set your own lineup');
  if (league.settings.best_ball) throw new ApiError(400, 'Best ball leagues set your lineup automatically');
  L.autoLineup(ctx.db, league, team, season.currentWeek(ctx.db));
  return { ok: true };
});

// Players, free agency, claims

route('GET', '/api/leagues/:id/players', (ctx) => {
  const user = me(ctx);
  const league = leagueOf(ctx);
  L.requireMember(ctx.db, league, user.id);
  return {
    players: L.listPlayers(ctx.db, league, user.id, {
      q: ctx.query.get('q') || '',
      pos: ctx.query.get('pos') || '',
      group: ctx.query.get('group') || '',
      status: ctx.query.get('status') || 'free',
      limit: ctx.query.get('limit')
    })
  };
});

route('GET', '/api/players/:id', (ctx) => {
  const user = me(ctx);
  const p = L.playerRow(ctx.db, ctx.params.id);
  if (!p) throw new ApiError(404, 'Player not found');
  let league = null;
  const leagueId = Number(ctx.query.get('league'));
  if (leagueId) {
    league = L.getLeague(ctx.db, leagueId);
    L.requireMember(ctx.db, league, user.id);
  }
  const scoring = scoringFor(league ? league.settings : DEFAULT_SETTINGS);
  const games = p.position === 'DEF' ? defenseLog(ctx.db, p, scoring) : playerLog(ctx.db, p, scoring);
  const week = season.currentWeek(ctx.db);
  let owner = null;
  let projection = null;
  let game = null;
  if (league) {
    const teamId = L.ownerMap(ctx.db, league.id).get(p.id);
    if (teamId !== undefined) owner = flow.teamSummary(ctx.db, L.teamOf(ctx.db, league, teamId));
    projection = season.projectionMap(ctx.db, league.season, league.settings, week).get(p.id) || 0;
    const k = L.kickoffsForWeek(ctx.db, league.season, week).get(p.team_id) || null;
    game = k ? { start: k.start, completed: k.completed, locked: L.hasKickedOff(k) } : null;
  }
  return { player: L.playerCard(p), games, owner, projection, week, scoring, game };
});

route('POST', '/api/leagues/:id/players/:pid/add', (ctx) => {
  const user = me(ctx);
  const league = leagueOf(ctx);
  const team = L.requireMember(ctx.db, league, user.id);
  const p = L.addPlayer(ctx.db, league, team, ctx.params.pid, ctx.body.drop_player_id || null);
  return { ok: true, player: p.name };
});

route('POST', '/api/leagues/:id/players/:pid/claim', (ctx) => {
  const user = me(ctx);
  const league = leagueOf(ctx);
  const team = L.requireMember(ctx.db, league, user.id);
  L.createClaim(ctx.db, league, team, ctx.params.pid, ctx.body.drop_player_id || null, ctx.body.bid);
  return { ok: true };
});

route('DELETE', '/api/leagues/:id/claims/:claimId', (ctx) => {
  const user = me(ctx);
  const league = leagueOf(ctx);
  const team = L.requireMember(ctx.db, league, user.id);
  L.cancelClaim(ctx.db, league, team, idParam(ctx.params.claimId));
  return { ok: true };
});

route('POST', '/api/leagues/:id/drop/:pid', (ctx) => {
  const user = me(ctx);
  const league = leagueOf(ctx);
  const team = L.requireMember(ctx.db, league, user.id);
  L.dropPlayer(ctx.db, league, team, ctx.params.pid);
  return { ok: true };
});

route('GET', '/api/leagues/:id/activity', (ctx) => {
  const user = me(ctx);
  const league = leagueOf(ctx);
  L.requireMember(ctx.db, league, user.id);
  const rows = ctx.db.prepare(`
    SELECT t.id, t.week, t.kind, t.detail, t.created_at, ft.name AS team_name
    FROM transactions t LEFT JOIN fantasy_teams ft ON ft.id = t.team_id
    WHERE t.league_id = ? AND t.kind != 'draft'
    ORDER BY t.id DESC LIMIT 100
  `).all(league.id);
  return {
    activity: rows.map((r) => ({
      id: r.id,
      week: r.week,
      kind: r.kind,
      team: r.team_name,
      created_at: r.created_at,
      detail: JSON.parse(r.detail)
    }))
  };
});

// Trades

route('GET', '/api/leagues/:id/trades', (ctx) => {
  const user = me(ctx);
  const league = leagueOf(ctx);
  L.requireMember(ctx.db, league, user.id);
  const names = (ids) => ids.map((id) => {
    const p = L.playerRow(ctx.db, id);
    return p ? { id, name: p.name, position: p.position, school: p.school } : { id, name: id };
  });
  const teams = new Map(L.teamsOf(ctx.db, league.id).map((t) => [t.id, t]));
  const rows = ctx.db.prepare('SELECT * FROM trades WHERE league_id = ? ORDER BY id DESC LIMIT 50').all(league.id);
  return {
    trades: rows.map((t) => {
      const from = teams.get(t.from_team_id);
      const to = teams.get(t.to_team_id);
      return {
        id: t.id,
        status: t.status,
        from: { id: from.id, name: from.name },
        to: { id: to.id, name: to.name },
        give: names(JSON.parse(t.give)),
        get: names(JSON.parse(t.get_players)),
        created_at: t.created_at,
        my_side: to.user_id === user.id ? 'to' : from.user_id === user.id ? 'from' : null
      };
    }),
    deadline_week: league.settings.trade_deadline_week || null,
    open: league.status === 'season' && (!league.settings.trade_deadline_week || season.currentWeek(ctx.db) <= league.settings.trade_deadline_week)
  };
});

// Trade analyzer: what a proposed trade is worth to the proposing team. Nothing is saved.
route('GET', '/api/leagues/:id/trades/preview', (ctx) => {
  const user = me(ctx);
  const league = leagueOf(ctx);
  L.requireMember(ctx.db, league, user.id);
  const split = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
  const give = split(ctx.query.get('give'));
  const get = split(ctx.query.get('get'));
  const week = season.currentWeek(ctx.db);
  const values = new Map(draft.draftRanking(ctx.db, league, week).map((c) => [c.id, { value: c.value, projection: c.projection }]));
  const summary = L.tradeSummary(values, give, get);
  return {
    give: give.map((id) => ({ id, name: (L.playerRow(ctx.db, id) || { name: id }).name, value: round1((values.get(id) || {}).value || 0) })),
    get: get.map((id) => ({ id, name: (L.playerRow(ctx.db, id) || { name: id }).name, value: round1((values.get(id) || {}).value || 0) })),
    value_change: summary.value_change,
    projection_change: summary.projection_change,
    verdict: tradeVerdict(summary.value_change)
  };
});

route('POST', '/api/leagues/:id/trades', (ctx) => {
  const user = me(ctx);
  const league = leagueOf(ctx);
  const from = L.requireMember(ctx.db, league, user.id);
  const id = L.proposeTrade(ctx.db, league, from, Number(ctx.body.to_team_id), ctx.body.give || [], ctx.body.get || []);
  return { ok: true, trade_id: id };
});

route('POST', '/api/leagues/:id/trades/:tradeId/counter', (ctx) => {
  const user = me(ctx);
  const league = leagueOf(ctx);
  L.requireMember(ctx.db, league, user.id);
  const id = L.counterTrade(ctx.db, league, user, idParam(ctx.params.tradeId), ctx.body.give || [], ctx.body.get || []);
  return { ok: true, trade_id: id };
});

for (const action of ['accept', 'decline', 'cancel']) {
  route('POST', `/api/leagues/:id/trades/:tradeId/${action}`, (ctx) => {
    const user = me(ctx);
    const league = leagueOf(ctx);
    L.requireMember(ctx.db, league, user.id);
    const id = idParam(ctx.params.tradeId);
    if (action === 'accept') L.acceptTrade(ctx.db, league, user, id);
    if (action === 'decline') L.declineTrade(ctx.db, league, user, id);
    if (action === 'cancel') L.cancelTrade(ctx.db, league, user, id);
    return { ok: true };
  });
}

// Scores, standings, rankings, recaps, awards

route('GET', '/api/leagues/:id/matchups', (ctx) => {
  const user = me(ctx);
  const league = leagueOf(ctx);
  L.requireMember(ctx.db, league, user.id);
  const liveWeek = season.currentWeek(ctx.db);
  const requested = Number(ctx.query.get('week'));
  const fallback = Math.min(Math.max(liveWeek, league.start_week || 1), flow.finalWeekOf(league));
  const week = requested || fallback;
  return {
    week,
    live_week: liveWeek,
    format: league.settings.format,
    weeks: weekList(league, liveWeek),
    matchups: flow.matchupsForWeek(ctx.db, league, week, liveWeek),
    // When the scores were last pulled from CFBD, and how many games of this week are under way now
    as_of: getMeta(ctx.db, 'last_ingest_at', null),
    live_games: season.liveGames(ctx.db, league.season, week).inProgress
  };
});

route('GET', '/api/leagues/:id/standings', (ctx) => {
  const user = me(ctx);
  const league = leagueOf(ctx);
  L.requireMember(ctx.db, league, user.id);
  const liveWeek = season.currentWeek(ctx.db);
  return {
    format: league.settings.format,
    standings: isActive(league) ? flow.standings(ctx.db, league, liveWeek) : [],
    through_week: Math.min(liveWeek - 1, league.settings.regular_weeks)
  };
});

route('GET', '/api/leagues/:id/rankings', (ctx) => {
  const user = me(ctx);
  const league = leagueOf(ctx);
  L.requireMember(ctx.db, league, user.id);
  const liveWeek = season.currentWeek(ctx.db);
  return {
    rankings: isActive(league) ? flow.powerRankings(ctx.db, league, liveWeek) : [],
    through_week: Math.min(liveWeek - 1, league.settings.regular_weeks)
  };
});

route('GET', '/api/leagues/:id/recap', (ctx) => {
  const user = me(ctx);
  const league = leagueOf(ctx);
  L.requireMember(ctx.db, league, user.id);
  const liveWeek = season.currentWeek(ctx.db);
  const lastDone = Math.min(liveWeek - 1, flow.finalWeekOf(league));
  const requested = Number(ctx.query.get('week'));
  const week = requested || Math.max(league.start_week || 1, lastDone);
  const recap = isActive(league) ? flow.weekRecap(ctx.db, league, week, liveWeek) : { week, ready: false, games: [] };
  return { recap, weeks: weekList(league, liveWeek), final_week: flow.finalWeekOf(league) };
});

route('GET', '/api/leagues/:id/awards', (ctx) => {
  const user = me(ctx);
  const league = leagueOf(ctx);
  L.requireMember(ctx.db, league, user.id);
  const liveWeek = season.currentWeek(ctx.db);
  return { awards: isActive(league) ? flow.seasonAwards(ctx.db, league, liveWeek) : null };
});

// History

route('GET', '/api/leagues/:id/history', (ctx) => {
  const user = me(ctx);
  const league = leagueOf(ctx);
  L.requireMember(ctx.db, league, user.id);
  const rows = ctx.db.prepare('SELECT * FROM season_results WHERE league_id = ? ORDER BY place').all(league.id);
  return { results: rows.map(mapResult) };
});

route('GET', '/api/history', (ctx) => {
  const user = me(ctx);
  const rows = ctx.db.prepare('SELECT * FROM season_results WHERE user_id = ? ORDER BY finished_at DESC, place').all(user.id);
  return { seasons: rows.map(mapResult) };
});

// Chat

route('GET', '/api/leagues/:id/messages', (ctx) => {
  const user = me(ctx);
  const league = leagueOf(ctx);
  L.requireMember(ctx.db, league, user.id);
  const after = Number(ctx.query.get('after')) || 0;
  const rows = ctx.db.prepare(`
    SELECT id, author, user_id, body, created_at FROM messages
    WHERE league_id = ? AND id > ? ORDER BY id DESC LIMIT 100
  `).all(league.id, after).reverse();
  const reactions = reactionsFor(ctx.db, rows.map((r) => r.id), user.id);
  return {
    messages: rows.map((r) => ({ ...r, mine: r.user_id === user.id, reactions: reactions[r.id] || [] })),
    reactions: REACTIONS
  };
});

route('POST', '/api/leagues/:id/messages', (ctx) => {
  const user = me(ctx);
  const league = leagueOf(ctx);
  const team = L.requireMember(ctx.db, league, user.id);
  const body = requireString(ctx.body.body, 'Message', { max: 500 });
  const info = ctx.db.prepare('INSERT INTO messages (league_id, user_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(league.id, user.id, team.name, body, nowIso());
  return { id: Number(info.lastInsertRowid) };
});

// Turns a reaction on or off for the signed-in user
route('POST', '/api/leagues/:id/messages/:mid/react', (ctx) => {
  const user = me(ctx);
  const league = leagueOf(ctx);
  L.requireMember(ctx.db, league, user.id);
  const messageId = idParam(ctx.params.mid);
  const emoji = String(ctx.body.emoji || '');
  if (!REACTIONS.includes(emoji)) throw new ApiError(400, 'That reaction is not available');
  const msg = ctx.db.prepare('SELECT id FROM messages WHERE id = ? AND league_id = ?').get(messageId, league.id);
  if (!msg) throw new ApiError(404, 'Message not found');
  const existing = ctx.db.prepare('SELECT 1 FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
    .get(messageId, user.id, emoji);
  if (existing) {
    ctx.db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(messageId, user.id, emoji);
  } else {
    ctx.db.prepare('INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(messageId, user.id, emoji);
  }
  return { reactions: reactionsFor(ctx.db, [messageId], user.id)[messageId] || [] };
});

// Settings > Help: a note to whoever runs the app. Stored on the server and read with `node src/cli.js feedback`.
route('POST', '/api/feedback', (ctx) => {
  const user = me(ctx);
  const text = String(ctx.body.body || '').trim();
  if (text.length < 10) throw new ApiError(400, 'Write a little more so we know what to look at (at least 10 characters)');
  if (text.length > 1000) throw new ApiError(400, 'Keep the message to 1000 characters or fewer');
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const sent = ctx.db.prepare('SELECT COUNT(*) AS n FROM feedback WHERE user_id = ? AND created_at > ?').get(user.id, since).n;
  if (sent >= FEEDBACK_PER_DAY) throw new ApiError(429, 'You have sent several messages today. Try again tomorrow.');
  let leagueId = null;
  if (ctx.body.league_id) {
    const league = L.getLeague(ctx.db, idParam(ctx.body.league_id));
    L.requireMember(ctx.db, league, user.id);
    leagueId = league.id;
  }
  ctx.db.prepare('INSERT INTO feedback (user_id, league_id, body, created_at) VALUES (?, ?, ?, ?)')
    .run(user.id, leagueId, text, nowIso());
  return { ok: true };
});

// Admin: close the current week (requires ADMIN_TOKEN, sent as X-Admin-Token)

route('POST', '/api/admin/advance', (ctx) => {
  const expected = Buffer.from(process.env.ADMIN_TOKEN || '');
  const given = Buffer.from(String(ctx.req.headers['x-admin-token'] || ''));
  const ok = expected.length >= 16 && given.length === expected.length && crypto.timingSafeEqual(given, expected);
  if (!ok) throw new ApiError(403, 'Admin token required');
  return flow.advanceWeek(ctx.db, SEASON);
});

// ---- Dispatcher --------------------------------------------------------------

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function matchRoute(method, pathname) {
  let pathMatched = false;
  for (const r of routes) {
    const m = pathname.match(r.re);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== method) continue;
    const params = {};
    r.keys.forEach((k, i) => {
      try {
        params[k] = decodeURIComponent(m[i + 1]);
      } catch (err) {
        throw new ApiError(400, 'Bad URL encoding');
      }
    });
    return { route: r, params };
  }
  return { pathMatched };
}

// Runs one API request. Returns the JSON body (or throws ApiError).
async function handleApi(req, ctx) {
  const hit = matchRoute(req.method, ctx.pathname);
  if (!hit.route) {
    throw hit.pathMatched ? new ApiError(405, 'Method not allowed') : new ApiError(404, 'Not found');
  }
  const body = MUTATING.has(req.method) ? await readJson(req) : {};
  const user = sessionUser(ctx.db, ctx.token);
  return tx(ctx.db, () => hit.route.handler({ ...ctx, limits: ctx.limits || DEFAULT_LIMITS, req, params: hit.params, body, user }));
}

module.exports = { handleApi, tokenFrom, sessionUser, SESSION_DAYS, routes, newRecoveryCode, normalizeCode };
