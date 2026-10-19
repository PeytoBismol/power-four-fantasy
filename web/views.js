'use strict';

// Screen markup. Each function returns an HTML string that app.js mounts.
// Text from the server always goes through esc() before it reaches the page.

const SCORING_FIELDS = [
  ['pass_yd', 'Passing yards', 'per yard'],
  ['pass_td', 'Passing TD', 'each'],
  ['pass_int', 'Interception thrown', 'each'],
  ['rush_yd', 'Rushing yards', 'per yard'],
  ['rush_td', 'Rushing TD', 'each'],
  ['rec', 'Reception', 'each'],
  ['rec_yd', 'Receiving yards', 'per yard'],
  ['rec_td', 'Receiving TD', 'each'],
  ['fum_lost', 'Fumble lost', 'each'],
  ['fg', 'Field goal made', 'each'],
  ['xp', 'Extra point made', 'each'],
  ['def_sack', 'Sack (defense)', 'each'],
  ['def_int', 'Interception (defense)', 'each'],
  ['def_td', 'Defensive TD', 'each']
];

const NAV_TABS = [
  { key: 'home', label: 'Home', icon: '<path d="M3 11l9-7 9 7v9h-6v-6H9v6H3z"/>' },
  { key: 'team', label: 'Team', icon: '<path d="M8 4l-5 3 2 4 2-1v10h10V10l2 1 2-4-5-3c-1 2-7 2-8 0z"/>' },
  { key: 'players', label: 'Players', icon: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4"/>' },
  { key: 'scores', label: 'Scores', icon: '<path d="M4 20h16M7 16v-5M12 16V6M17 16v-8"/>' },
  { key: 'chat', label: 'Chat', icon: '<path d="M4 5h16v11H9l-5 4z"/>' }
];

const STATUS_LABEL = {
  predraft: ['Pre-draft', ''],
  drafting: ['Draft live', 'gold'],
  season: ['In season', 'win'],
  complete: ['Final', 'muted']
};

const SLOT_ORDER = ['QB', 'RB', 'WR', 'TE', 'WRT', 'K', 'DEF', 'BN'];
const REACTIONS = ['👍', '🔥', '😂', '😮', '🏈', '👎'];
const THEMES = [['system', 'Match phone'], ['light', 'Light'], ['dark', 'Dark']];

// ---- Small helpers ---------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const HEX = /^#[0-9a-f]{6}$/i;
const hexOr = (c, fallback) => (HEX.test(c || '') ? c.toUpperCase() : fallback);
const fmt = (n, d = 1) => (n === null || n === undefined || Number.isNaN(Number(n)) ? '–' : Number(n).toFixed(d));
const signed = (n) => (n > 0 ? `+${fmt(n)}` : fmt(n));
const initials = (name) => String(name || '?').split(/\s+/).filter((w) => /^[A-Za-z]/.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const ordinal = (n) => {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
};
const posTag = (pos) => `<span class="pos pos-${esc(pos)}">${esc(pos)}</span>`;
const pill = (text, cls = '') => `<span class="pill ${cls}">${esc(text)}</span>`;
const statusPill = (s) => { const [t, c] = STATUS_LABEL[s] || [s, '']; return pill(t, c); };
const emptyNote = (text) => `<div class="empty-note">${esc(text)}</div>`;
const sectionHead = (title, right = '') => `<div class="section-row"><h2>${esc(title)}</h2>${right}</div>`;
const chip = (act, value, label, on) => `<button class="chip ${on ? 'on' : ''}" data-act="${act}" data-v="${esc(value)}" aria-pressed="${on}">${esc(label)}</button>`;

// Kickoff time in the phone's own time zone, e.g. "Sat 3:30 PM"
function kickoffText(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

// Relative luminance decides whether a badge's text should be white or near-black
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function inkOn(hex) {
  const L = luminance(hex);
  const dark = luminance('#111725');
  return (1.05 / (L + 0.05)) >= ((L + 0.05) / (dark + 0.05)) ? '#ffffff' : '#111725';
}

// School badge in the school's own colors (CFBD supplies them)
function badge(team, cls = '') {
  const c = hexOr(team && team.color, '#5a6276');
  const c2 = hexOr(team && team.alt_color, '#ffffff');
  const label = esc((team && team.abbreviation) || initials(team && team.school));
  return `<span class="tbadge ${cls}" style="--c:${c};--c2:${c2};--ink:${inkOn(c)}" aria-hidden="true">${label}</span>`;
}

// Injury badge from a hand-entered note. Out and Injured reserve are red, Doubtful orange, Questionable gold.
const INJURY_CLASS = { Questionable: 'q', Doubtful: 'd', Out: 'o', 'Injured reserve': 'o' };
function injuryTag(p) {
  if (!p || !p.injury) return '';
  const cls = INJURY_CLASS[p.injury.status] || 'q';
  return `<span class="inj inj-${cls}" title="${esc(p.injury.note || p.injury.status)}">${esc(p.injury.status)}</span>`;
}

function injuryLine(p) {
  if (!p || !p.injury) return '';
  const note = p.injury.note ? ` · ${esc(p.injury.note)}` : '';
  return `<p class="fine">${esc(p.injury.status)}${note}. Set by hand by the league organiser. It is not from an official injury report.</p>`;
}

function playerRow(p, { right = '', action = 'open', attrs = '', extra = '' } = {}) {
  return `<div class="prow" role="button" tabindex="0" data-act="${action}" data-pid="${esc(p.id)}" ${attrs}>
    ${badge(p.team)}
    <div class="pmain">
      <div class="pname">${esc(p.name)}${injuryTag(p)}${extra}</div>
      <div class="psub">${posTag(p.position)}<span class="truncate">${esc(p.team.school)}</span></div>
    </div>
    <div class="pright">${right}</div>
  </div>`;
}

function textField({ name, label, type = 'text', value = '', placeholder = '', required = false, maxlength = 120, autocomplete = 'off', hint = '', min, max, step }) {
  return `<label class="field"><span>${esc(label)}</span>
    <input name="${esc(name)}" type="${esc(type)}" value="${esc(value)}" placeholder="${esc(placeholder)}"
      maxlength="${maxlength}" autocomplete="${esc(autocomplete)}" ${required ? 'required' : ''}
      ${min !== undefined ? `min="${esc(min)}"` : ''} ${max !== undefined ? `max="${esc(max)}"` : ''} ${step !== undefined ? `step="${esc(step)}"` : ''}>
    ${hint ? `<small class="muted">${esc(hint)}</small>` : ''}</label>`;
}

function selectField(name, label, options, selected) {
  return `<label class="field"><span>${esc(label)}</span><select name="${esc(name)}">${options.map(([v, t]) =>
    `<option value="${esc(v)}" ${String(v) === String(selected) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
}

function checkField(name, label, checked) {
  return `<label class="check-field"><input type="checkbox" name="${esc(name)}" ${checked ? 'checked' : ''}><span>${esc(label)}</span></label>`;
}

// The league rules that the commissioner sets before the draft
function ruleFields(s, { withName = false, name = '' } = {}) {
  return `
    ${withName ? textField({ name: 'name', label: 'League name', placeholder: 'Power Four Dynasty', value: name, required: true, maxlength: 60 }) : ''}
    ${selectField('format', 'Scoring format', [['h2h', 'Weekly head-to-head'], ['points', 'Season points (no matchups)']], s.format || 'h2h')}
    ${selectField('regular_weeks', 'Regular season', range(8, 16).map((n) => [n, `${n} weeks`]), s.regular_weeks)}
    ${selectField('playoff_teams', 'Playoffs', [[4, '4 teams: semifinals and final'], [0, 'No playoffs']], s.playoff_teams)}
    ${selectField('waiver_mode', 'Waivers', [['priority', 'Priority order (rotating)'], ['faab', 'FAAB (sealed budget bids)']], s.waiver_mode || 'priority')}
    ${textField({ name: 'faab_budget', label: 'FAAB budget per team', type: 'number', value: s.faab_budget ?? 100, min: 0, max: 1000, step: 1, maxlength: 4, hint: 'Spent on waiver bids. Used only when waivers are FAAB.' })}
    ${selectField('trade_deadline_week', 'Trade deadline', [[0, 'No deadline'], ...range(1, 15).map((w) => [w, `Through week ${w}`])], s.trade_deadline_week || 0)}
    ${checkField('best_ball', 'Best ball: the app sets every lineup each week', s.best_ball)}
    ${selectField('pick_seconds', 'Pick timer', [[60, '60 seconds'], [90, '90 seconds'], [120, '2 minutes'], [300, '5 minutes']], s.pick_seconds)}`;
}

// ---- Auth and account ------------------------------------------------------

function brandBlock() {
  return `<div class="brand">
      <div class="logo" aria-hidden="true">PF</div>
      <h1>Power Four<br>Fantasy</h1>
      <p class="muted">Fantasy football for the Power Four and Notre Dame. Draft, trade and set lineups against your friends.</p>
    </div>`;
}

// A support address from the server, when one is set. Shown where people get stuck before they can sign in.
function helpLine(meta) {
  if (!meta || !meta.support_email) return '';
  return `<p class="center muted small">Stuck? Email <a href="mailto:${esc(meta.support_email)}">${esc(meta.support_email)}</a></p>`;
}

function authPage(mode, error = '', meta = {}) {
  if (mode === 'forgot') {
    return `
  <section class="auth">
    ${brandBlock()}
    <form class="card form" data-form="reset">
      <h2>Reset password</h2>
      <p class="fine">Enter the recovery code you saved when you created your account. It looks like ABCD-EFGH-JKLM-NPQR.</p>
      ${textField({ name: 'email', label: 'Email', type: 'email', required: true, maxlength: 120, autocomplete: 'email' })}
      ${textField({ name: 'recovery_code', label: 'Recovery code', required: true, maxlength: 40, autocomplete: 'off' })}
      ${textField({ name: 'password', label: 'New password', type: 'password', required: true, maxlength: 200, autocomplete: 'new-password', hint: 'At least 8 characters' })}
      <p class="form-error" role="alert">${esc(error)}</p>
      <button class="btn primary full" type="submit">Reset and sign in</button>
    </form>
    <p class="center muted small"><button class="linkbtn" data-act="go-login">Back to sign in</button></p>
  </section>`;
  }
  const signup = mode === 'signup';
  return `
  <section class="auth">
    ${brandBlock()}
    <form class="card form" data-form="auth" data-mode="${signup ? 'signup' : 'login'}">
      <h2>${signup ? 'Create account' : 'Sign in'}</h2>
      ${signup ? textField({ name: 'name', label: 'Your name', required: true, maxlength: 40, autocomplete: 'name' }) : ''}
      ${textField({ name: 'email', label: 'Email', type: 'email', required: true, maxlength: 120, autocomplete: 'email' })}
      ${textField({ name: 'password', label: 'Password', type: 'password', required: true, maxlength: 200, autocomplete: signup ? 'new-password' : 'current-password', hint: signup ? 'At least 8 characters' : '' })}
      <p class="form-error" role="alert">${esc(error)}</p>
      <button class="btn primary full" type="submit">${signup ? 'Create account' : 'Sign in'}</button>
      ${signup ? '' : '<p class="center"><button class="linkbtn small" data-act="forgot">Forgot your password?</button></p>'}
    </form>
    <p class="center muted small">${signup ? 'Already have an account?' : 'New here?'}
      <button class="linkbtn" data-act="switch-auth">${signup ? 'Sign in' : 'Create an account'}</button></p>
    ${helpLine(meta)}
  </section>`;
}

// Shown once after sign-up or a reset. The code is never stored in the page.
function recoveryPage(code) {
  return `
  <div class="page-head"><div><h1>Save your recovery code</h1><p class="meta">You need it to get back in if you forget your password.</p></div></div>
  <section class="card hero">
    <p class="eyebrow">Recovery code</p>
    <p class="display invite-code">${esc(code)}</p>
    <p class="muted">Write it down or keep it in a password manager. It is shown once. You can get a new one any time from Account.</p>
    <div class="actions"><button class="btn small" data-act="copy-code" data-code="${esc(code)}" data-label="Recovery code copied">Copy</button></div>
    <a class="btn primary" href="#/leagues">I have saved it</a>
  </section>`;
}

function leaguesPage(leagues, meta, theme) {
  const cards = leagues.map((l) => `<a class="prow league-row" href="#/l/${l.id}/home">
      <div class="pmain">
        <div class="pname">${esc(l.name)}</div>
        <div class="psub">${statusPill(l.status)}<span class="truncate">${esc(l.my_team.name)} · ${l.members} of ${l.team_count} joined</span></div>
      </div>
      <span class="chev" aria-hidden="true">›</span>
    </a>`).join('');
  return `
  <div class="page-head"><div><h1>Your leagues</h1><p class="meta">${esc(meta.season)} season · Week ${esc(meta.current_week)}</p></div></div>
  <div class="actions">
    <a class="btn primary small" href="#/new">Create league</a>
    <a class="btn small" href="#/join">Join with code</a>
    <a class="btn small" href="#/history">Past seasons</a>
  </div>
  ${leagues.length
    ? `<div class="list">${cards}</div>`
    : `<section class="card"><p class="display">No leagues yet</p><p class="muted">Create a league and send the invite code to your friends, or join one someone sent you.</p></section>`}
  <section class="card account">
    <h2>Appearance</h2>
    <div class="chips" role="group" aria-label="Appearance">${THEMES.map(([v, l]) => chip('theme', v, l, theme === v)).join('')}</div>
    <h2>Recovery code</h2>
    <p class="fine">Make a new code here. The old one stops working. Enter your current password to confirm.</p>
    <form class="form" data-form="recovery-code">
      ${textField({ name: 'password', label: 'Current password', type: 'password', required: true, maxlength: 200, autocomplete: 'current-password' })}
      <p class="form-error" role="alert"></p>
      <button class="btn small" type="submit">Get a new recovery code</button>
    </form>
  </section>
  <p class="center"><button class="linkbtn" data-act="logout">Sign out</button></p>
  ${helpLine(meta)}`;
}

function historyPage(seasons) {
  const rows = seasons.map((s) => `<div class="card trade">
      <div class="fine">${esc(s.league_name)} · ${esc(s.season)}</div>
      <div class="pname">${esc(s.team_name)} ${s.champion ? pill('Champion', 'gold') : ''}</div>
      <div class="psub">${esc(ordinal(s.place))} place · ${s.wins}-${s.losses} · ${fmt(s.points_for)} points</div>
    </div>`).join('');
  return `
  <div class="page-head"><div><h1>Past seasons</h1><p class="meta">Finished leagues you played in</p></div></div>
  ${seasons.length ? rows : emptyNote('Finished leagues show up here once the season ends.')}
  <p class="center"><a class="btn small" href="#/leagues">Back to your leagues</a></p>`;
}

function newLeaguePage(d) {
  return `
  <div class="page-head"><div><h1>New league</h1><p class="meta">Snake draft, then the season.</p></div></div>
  <form class="card form" data-form="new-league">
    ${textField({ name: 'name', label: 'League name', placeholder: 'Power Four Dynasty', required: true, maxlength: 60 })}
    ${selectField('team_count', 'Teams', range(4, 16).map((n) => [n, `${n} teams`]), d.team_count)}
    ${ruleFields(d)}
    <p class="notice">Starting lineup: QB, 2 RB, 2 WR, TE, WRT (RB, WR or TE), K and DEF. Bench of 6.</p>
    <p class="form-error" role="alert"></p>
    <button class="btn primary full" type="submit">Create league</button>
  </form>`;
}

function joinPage() {
  return `
  <div class="page-head"><div><h1>Join a league</h1><p class="meta">Ask the commissioner for the six-character code.</p></div></div>
  <form class="card form" data-form="join">
    ${textField({ name: 'code', label: 'Invite code', placeholder: 'ABC123', required: true, maxlength: 6, autocomplete: 'off' })}
    <p class="form-error" role="alert"></p>
    <button class="btn primary full" type="submit">Join league</button>
  </form>`;
}

function errorPage(message) {
  return `<section class="card"><p class="display">Something went wrong</p><p class="muted">${esc(message)}</p></section>
  <p class="center"><a class="btn small" href="#/leagues">Back to your leagues</a></p>`;
}

// ---- League shell ----------------------------------------------------------

// Alerts that need a coach now. The tab an alert points to is hidden while the coach is on it, since that tab shows it.
function alertsBanner(alerts, tab, leagueId) {
  const shown = alerts.filter((a) => a.tab !== tab);
  if (!shown.length) return '';
  const rows = shown.slice(0, 3).map((a) => `<a class="alert ${esc(a.level)}" href="#/l/${leagueId}/${esc(a.tab)}">
      <span>${esc(a.message)}</span><span class="chev" aria-hidden="true">›</span></a>`).join('');
  const more = shown.length > 3 ? `<p class="fine">${shown.length - 3} more on other tabs.</p>` : '';
  return `<section class="alerts" role="status" aria-label="Alerts">${rows}${more}</section>`;
}

function leagueShell(detail, tab, body, sheet = '') {
  const L = detail.league;
  const myName = L.my_team ? L.my_team.name : 'Your team';
  const label = { predraft: 'Pre-draft', drafting: 'Draft live', season: `Week ${detail.week}`, complete: 'Final' }[L.status] || '';
  const tabs = NAV_TABS.map((t) => `<a class="tab ${tab === t.key ? 'on' : ''}" href="#/l/${L.id}/${t.key}"
      ${tab === t.key ? 'aria-current="page"' : ''}>
      <svg viewBox="0 0 24 24" aria-hidden="true">${t.icon}</svg><span>${t.label}</span></a>`).join('');
  return `
  <header class="topbar">
    <div class="minw">
      <div class="league">${esc(L.name)}</div>
      <div class="meta">${esc(L.season)} season · ${esc(label)}</div>
    </div>
    <a class="avatar" href="#/l/${L.id}/team" title="${esc(myName)}" aria-label="Your team">${esc(initials(myName))}</a>
  </header>
  <main id="main">${alertsBanner(detail.alerts || [], tab, L.id)}${body}</main>
  <nav class="nav" aria-label="League"><div class="nav-inner">${tabs}</div></nav>
  ${sheet}`;
}

// ---- Home ------------------------------------------------------------------

function myMatchup(matchups, myTeamId) {
  const m = matchups.find((x) => (x.home && x.home.team.id === myTeamId) || (x.away && x.away.team.id === myTeamId));
  if (!m) return null;
  const mine = m.home && m.home.team.id === myTeamId ? m.home : m.away;
  const theirs = mine === m.home ? m.away : m.home;
  return { mine, theirs, status: m.status, playoff: m.playoff_round > 0 };
}

function homeTab(h) {
  const L = h.detail.league;
  const points = L.settings.format === 'points';
  const parts = [statusCard(h)];
  if ((L.status === 'season' || L.status === 'complete') && !points) {
    parts.push(`<div>${matchupCard(myMatchup(h.matchups.matchups, h.detail.my_team_id), h.matchups.week, L.id)}${scoreStamp(h.matchups)}</div>`);
  }
  parts.push(linksCard(h));
  if (h.standings.length) parts.push(standingsCard(h.standings, h.detail.my_team_id, L.id, points));
  if (h.rankings && h.rankings.length) parts.push(rankingsCard(h.rankings, h.detail.my_team_id, L.id));
  if (h.awards) parts.push(awardsCard(h.awards));
  if (h.results && h.results.length) parts.push(resultsCard(h.results));
  parts.push(activityCard(h.activity));
  parts.push(inviteCard(L));
  // Phones show one column. Wide screens put the cards side by side; the status card always spans both.
  const [first, ...rest] = parts;
  return `<div class="page-head"><div><h1>Home</h1><p class="meta">${esc(L.my_team ? L.my_team.name : '')}</p></div></div>
    <div class="home-grid"><div class="span-2">${first}</div>${rest.join('')}</div>`;
}

function statusCard(h) {
  const L = h.detail.league;
  if (L.status === 'predraft') {
    const picks = h.detail.capacity * h.detail.teams.length;
    return `<section class="card hero">
      <p class="eyebrow">Pre-draft</p>
      <p class="display">Draft night is coming</p>
      <p class="muted">${h.detail.teams.length} teams, ${h.detail.capacity} picks each (${picks} total). Set the draft order on the Draft tab, or shuffle it when the draft starts.</p>
      ${L.commissioner
        ? '<button class="btn primary" data-act="start-draft">Start draft</button>'
        : '<p class="fine">Waiting for the commissioner to start the draft.</p>'}
    </section>`;
  }
  if (L.status === 'drafting') {
    return `<section class="card hero live">
      <p class="eyebrow">Live now</p>
      <p class="display">The draft is on</p>
      <a class="btn primary" href="#/l/${L.id}/draft">Enter draft room</a>
    </section>`;
  }
  if (L.status === 'complete') {
    return `<section class="card hero"><p class="eyebrow">Season over</p><p class="display">Final</p><p class="muted">The results are saved to Past seasons. Check the awards and the activity feed for the season's moves.</p></section>`;
  }
  return `<section class="card hero"><p class="eyebrow">Week ${h.detail.week}</p><p class="display">Lineups are live</p><p class="muted">Each player locks when his school kicks off. Set your starters on the Team tab before then.</p></section>`;
}

function matchupCard(m, week, leagueId) {
  if (!m) return `<section class="card"><p class="eyebrow">Week ${week}</p><p class="muted">No matchup this week.</p></section>`;
  const total = (m.mine.points || 0) + (m.theirs.points || 0);
  const share = total > 0 ? Math.round((m.mine.points / total) * 100) : 50;
  const label = m.status === 'live' ? 'Live' : m.status === 'final' ? 'Final' : 'Upcoming';
  return `<a class="card matchup" href="#/l/${leagueId}/scores">
    <div class="eyebrow">${m.playoff ? 'Playoffs' : 'Week ' + week} · ${label}</div>
    <div class="versus">
      <div class="vside"><div class="vname">${esc(m.mine.team.name)}</div><div class="vscore">${fmt(m.mine.points)}</div></div>
      <div class="vs">vs</div>
      <div class="vside right"><div class="vname">${esc(m.theirs ? m.theirs.team.name : 'Bye')}</div><div class="vscore muted">${fmt(m.theirs ? m.theirs.points : 0)}</div></div>
    </div>
    <div class="share" aria-hidden="true"><span style="width:${share}%"></span></div>
  </a>`;
}

function linkRow(href, title, sub) {
  return `<a class="prow link-row" href="${href}"><div class="pmain"><div class="pname">${esc(title)}</div><div class="psub">${esc(sub)}</div></div><span class="chev" aria-hidden="true">›</span></a>`;
}

function linksCard(h) {
  const L = h.detail.league;
  const incoming = h.trades.filter((t) => t.status === 'pending' && t.my_side === 'to').length;
  const draftSub = { predraft: 'Set the order and your queue', drafting: 'On the clock now', season: 'Draft finished', complete: 'Draft finished' }[L.status];
  return `<section>${sectionHead('League')}<div class="list">
    ${linkRow(`#/l/${L.id}/draft`, 'Draft room', draftSub)}
    ${linkRow(`#/l/${L.id}/trades`, 'Trades', incoming ? `${incoming} waiting for your answer` : 'Propose a trade')}
    ${linkRow(`#/l/${L.id}/settings`, 'Settings', L.commissioner ? 'You run this league' : 'Rules and scoring')}
  </div></section>`;
}

function standingsCard(rows, myId, leagueId, points) {
  const body = rows.map((r) => `<tr class="${r.team.id === myId ? 'me' : ''}">
      <td>${r.rank}</td><td><a href="#/l/${leagueId}/team/${r.team.id}">${esc(r.team.name)}</a></td>
      ${points ? '' : `<td>${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ''}</td>`}
      <td>${fmt(r.points_for)}</td>${points ? '' : `<td>${fmt(r.points_against)}</td>`}</tr>`).join('');
  return `<section>${sectionHead('Standings')}<div class="card flush table-wrap">
    <table class="standings"><thead><tr><th>#</th><th>Team</th>${points ? '' : '<th>W-L</th>'}<th>${points ? 'Points' : 'PF'}</th>${points ? '' : '<th>PA</th>'}</tr></thead>
    <tbody>${body}</tbody></table></div></section>`;
}

function movement(n) {
  if (n === null || n === undefined) return '<span class="muted">–</span>';
  if (n > 0) return `<span class="up">▲ ${n}</span>`;
  if (n < 0) return `<span class="down">▼ ${-n}</span>`;
  return '<span class="muted">–</span>';
}

function rankingsCard(rows, myId, leagueId) {
  const body = rows.map((r) => `<tr class="${r.team.id === myId ? 'me' : ''}">
      <td>${r.power_rank}</td><td><a href="#/l/${leagueId}/team/${r.team.id}">${esc(r.team.name)}</a></td>
      <td>${fmt(r.last3_avg)}</td><td>${movement(r.move)}</td></tr>`).join('');
  return `<section>${sectionHead('Power rankings', '<span class="fine">Record, then last three weeks</span>')}<div class="card flush table-wrap">
    <table class="standings"><thead><tr><th>#</th><th>Team</th><th>Last 3 avg</th><th>Move</th></tr></thead>
    <tbody>${body}</tbody></table></div></section>`;
}

function awardsCard(a) {
  const lines = [];
  if (a.top_player) lines.push(['Top player', `${a.top_player.name} (${a.top_player.school || ''}), ${fmt(a.top_player.points)} pts for ${a.top_player.team}`]);
  if (a.best_team) lines.push(['Best team', `${a.best_team.team}, ${fmt(a.best_team.points)} pts`]);
  if (a.best_week) lines.push(['Best single week', `${a.best_week.team}, week ${a.best_week.week}: ${fmt(a.best_week.points)} pts`]);
  if (a.biggest_blowout) lines.push(['Biggest blowout', `${a.biggest_blowout.a} ${fmt(a.biggest_blowout.a_points)}, ${a.biggest_blowout.b} ${fmt(a.biggest_blowout.b_points)} (week ${a.biggest_blowout.week})`]);
  if (a.closest_game) lines.push(['Closest game', `${a.closest_game.a} ${fmt(a.closest_game.a_points)}, ${a.closest_game.b} ${fmt(a.closest_game.b_points)} (week ${a.closest_game.week})`]);
  if (!lines.length) return '';
  return `<section>${sectionHead('Awards so far')}<div class="card feed">${lines.map(([k, v]) => `<div class="feed-item"><b>${esc(k)}:</b> ${esc(v)}</div>`).join('')}</div></section>`;
}

function resultsCard(results) {
  const rows = results.map((r) => `<div class="prow static">
      <div class="pmain"><div class="pname">${esc(r.team_name)} ${r.champion ? pill('Champion', 'gold') : ''}</div>
      <div class="psub">${esc(ordinal(r.place))} · ${r.wins}-${r.losses} · ${fmt(r.points_for)} pts</div></div></div>`).join('');
  return `<section>${sectionHead('Final standings')}<div class="list">${rows}</div></section>`;
}

function activityText(a) {
  const d = a.detail || {};
  const team = a.team || 'A team';
  switch (a.kind) {
    case 'add': return `${team} picked up ${d.player}${d.dropped ? ' and dropped a player' : ''}.`;
    case 'waiver': return `${team} won ${d.player} on waivers${d.bid ? ` for $${d.bid}` : ''}${d.dropped ? ' and dropped a player' : ''}.`;
    case 'drop': return `${team} dropped ${d.player}.`;
    case 'trade': return `${d.from} sent ${(d.give || []).join(', ') || 'nothing'} to ${d.to} for ${(d.get || []).join(', ') || 'nothing'}.`;
    case 'join': return `${d.user} joined the league.`;
    case 'released': return `${d.by} removed ${d.member} from ${d.team}. The team is a CPU team until someone joins.`;
    case 'champion': return `${team} won the championship.`;
    case 'transfer': return `${d.player} transferred from ${d.from} to ${d.to}. He stays on ${team}.`;
    case 'departed': return `${d.player} left the Power Four (${d.school}). He was dropped from ${team}.`;
    default: return `${team}: ${a.kind}`;
  }
}

function activityCard(items) {
  const body = items.length
    ? `<div class="card feed">${items.slice(0, 12).map((a) => `<div class="feed-item">${esc(activityText(a))}</div>`).join('')}</div>`
    : emptyNote('Moves, trades and waiver wins show up here.');
  return `<section>${sectionHead('Activity')}${body}</section>`;
}

function inviteCard(L) {
  const note = L.status === 'season'
    ? '<p class="fine">The draft is done. This code only fills a team the commissioner has freed.</p>'
    : '';
  return `<section class="card invite">
    <div><p class="eyebrow">Invite code</p><p class="display invite-code">${esc(L.invite_code)}</p>${note}</div>
    <button class="btn small" data-act="copy-code" data-code="${esc(L.invite_code)}" data-label="Invite code copied">Copy</button>
  </section>`;
}

// ---- Team ------------------------------------------------------------------

function lockNote(entry) {
  if (entry.locked) return '<span class="lock">Locked · game underway</span>';
  if (entry.game && entry.game.completed) return '<span class="small muted">Final</span>';
  if (entry.game && entry.game.start) return `<span class="small muted">Kicks off ${esc(kickoffText(entry.game.start))}</span>`;
  return '';
}

function rosterRow(entry, label) {
  const p = entry.player;
  return `<div class="prow" role="button" tabindex="0" data-act="open" data-pid="${esc(p.id)}">
    <span class="lslot">${esc(label)}</span>
    ${badge(p.team)}
    <div class="pmain"><div class="pname">${esc(p.name)}${injuryTag(p)}</div>
      <div class="psub">${posTag(p.position)}<span class="truncate">${esc(p.team.school)}</span></div>
      <div class="psub">${lockNote(entry)}</div></div>
    <div class="pright"><div class="stat-stack"><span class="pts">${fmt(entry.points)}</span>
      <span class="small muted">proj ${fmt(entry.projection)}</span></div></div>
  </div>`;
}

function warningsCard(list) {
  if (!list || !list.length) return '';
  return `<section class="card warn" role="status"><p class="eyebrow">Before this week</p>
    <ul class="warn-list">${list.map((w) => `<li>${esc(w.message)}</li>`).join('')}</ul></section>`;
}

function claimsCard(claims, mine, faabMode) {
  if (!claims.length) return '';
  const rows = claims.map((c) => `<div class="prow static">
      <div class="pmain"><div class="pname">Claim ${esc(c.player.name)}</div>
        <div class="psub">${c.drop ? `Drop ${esc(c.drop.name)} · ` : ''}${faabMode ? `Bid $${c.bid} · ` : ''}${esc(c.note || c.status)}</div></div>
      <div class="pright">${pill(c.status, c.status === 'won' ? 'win' : c.status === 'pending' ? 'gold' : 'muted')}
        ${mine && c.status === 'pending' ? `<button class="btn small" data-act="cancel-claim" data-cid="${c.id}">Cancel</button>` : ''}</div>
    </div>`).join('');
  return `<section>${sectionHead('Waiver claims')}<div class="list">${rows}</div></section>`;
}

function teamTab(t, detail) {
  const mine = t.is_mine;
  const L = detail.league;
  const lines = [];
  for (const s of t.slots) {
    const occupants = t.roster.filter((r) => r.slot === s.key).sort((a, b) => b.projection - a.projection);
    for (let i = 0; i < s.count; i++) {
      lines.push({ label: s.count > 1 ? `${s.key}${i + 1}` : s.key, entry: occupants[i] || null });
    }
  }
  const starters = lines.map((l) => (l.entry
    ? rosterRow(l.entry, l.label)
    : `<div class="prow empty"><span class="lslot">${esc(l.label)}</span><span class="muted">Empty</span></div>`)).join('');
  const bench = t.roster.filter((r) => r.slot === 'BN').sort((a, b) => b.projection - a.projection);
  const benchRows = bench.length
    ? bench.map((r) => rosterRow(r, 'BN')).join('')
    : `<div class="prow empty"><span class="muted">No bench players</span></div>`;
  const rename = mine ? `<form class="card form-inline" data-form="rename-team">
      ${textField({ name: 'name', label: 'Team name', value: t.team.name, required: true, maxlength: 40 })}
      <button class="btn small" type="submit">Save</button></form>` : '';
  const faabMode = t.waiver_mode === 'faab';
  const bestBall = !!t.best_ball;
  const actions = mine && !bestBall ? `<div class="actions"><button class="btn small primary" data-act="auto-lineup">Set best lineup</button></div>` : '';
  const bestNote = mine && bestBall ? '<p class="notice">Best ball: the app starts your best projected lineup every week. Lineups cannot be edited.</p>' : '';
  return `
  <div class="page-head"><div><h1>${esc(t.team.name)}</h1><p class="meta">${esc(t.team.owner)}${mine ? ' · you' : ''}</p></div></div>
  <section class="card stats3">
    <div><span class="k">Points</span><b>${fmt(t.points_total)}</b></div>
    <div><span class="k">Projected</span><b>${fmt(t.projected_total)}</b></div>
    <div><span class="k">${faabMode && mine ? 'FAAB' : 'Roster'}</span><b>${faabMode && mine ? `$${t.faab}` : `${t.roster.length}/${t.capacity}`}</b></div>
  </section>
  ${mine ? warningsCard(t.warnings) : ''}
  ${actions}${bestNote}
  ${rename}
  <section>${sectionHead('Starters', `<span class="fine">Week ${t.week}</span>`)}<div class="list">${starters}</div></section>
  <section>${sectionHead('Bench')}<div class="list">${benchRows}</div></section>
  ${claimsCard(t.claims, mine, faabMode)}
  <p class="fine">${mine && !bestBall ? 'Tap a player to move them into a starting slot or onto the bench.' : ''}${L.status === 'season' ? ' Players are locked once their school kicks off.' : ''}</p>`;
}

// ---- Players ---------------------------------------------------------------

function playersTab(detail, meta, st) {
  const L = detail.league;
  const faab = L.settings.waiver_mode === 'faab';
  const note = L.status === 'season'
    ? (faab ? '<p class="notice">Waiver claims use sealed FAAB bids. The highest bid wins when the week closes.</p>' : '')
    : `<p class="notice">Free agents open once the draft is complete.</p>`;
  const groups = [['ALL', 'All conferences'], ...meta.groups.map((g) => [g.key, g.label])];
  return `
  <div class="page-head"><div><h1>Players</h1><p class="meta">Free agents, sorted by projection</p></div></div>
  ${note}
  <input class="search" data-input="q" type="search" placeholder="Search players or schools" value="${esc(st.q)}" aria-label="Search players" autocomplete="off">
  <div class="chips" role="group" aria-label="Position">${['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DEF'].map((p) => chip('pos', p, p === 'ALL' ? 'All' : p, st.pos === p)).join('')}</div>
  <div class="chips" role="group" aria-label="Conference">${groups.map(([k, l]) => chip('group', k, l, st.group === k)).join('')}</div>
  <div id="player-list">${emptyNote('Loading players…')}</div>`;
}

function playerListHtml(players, detail) {
  if (!players.length) return emptyNote('No free players match those filters.');
  const open = detail.league.status === 'season';
  return `<div class="list">${players.map((p) => playerRow(p, {
    right: `<span class="pts">${fmt(p.projection)}</span>${open ? `<button class="btn small" data-act="quick-add" data-pid="${esc(p.id)}" aria-label="Add ${esc(p.name)}">Add</button>` : ''}`
  })).join('')}</div>`;
}

// ---- Scores ----------------------------------------------------------------

function weekLabel(week, weeks) {
  const w = weeks.find((x) => x.week === week);
  return w && w.playoff ? 'Playoffs' : 'Regular season';
}

function lineupCol(side) {
  if (!side) return '';
  const starters = side.starters.slice().sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot));
  return `<div class="lcol"><div class="lhead">${esc(side.team.name)}</div>${starters.map((s) => `<div class="lrow">
      <span class="lslot">${esc(s.slot)}</span><span class="lname">${esc(s.name)}</span><span class="small">${fmt(s.points)}</span>
    </div>`).join('')}</div>`;
}

function matchCard(m, i, open, winnerId) {
  const side = (s) => (s
    ? `<div class="mrow"><span class="mname">${esc(s.team.name)}</span><span class="mscore ${winnerId === s.team.id ? 'win' : ''}">${fmt(s.points)}</span></div>`
    : `<div class="mrow"><span class="mname muted">Bye</span></div>`);
  const body = open ? `<div class="lineups">${lineupCol(m.home)}${lineupCol(m.away)}</div>` : '';
  const status = m.status === 'live' ? 'Live' : m.status === 'final' ? 'Final' : 'Upcoming';
  return `<section class="card match">
    <button class="match-head" data-act="match" data-i="${i}" aria-expanded="${open}">
      ${side(m.home)}${side(m.away)}
      <span class="small muted">${status}${open ? ' · tap to close' : ' · tap for lineups'}</span>
    </button>${body}</section>`;
}

function recapCard(r) {
  if (!r || !r.ready) return `<section class="card"><p class="eyebrow">Recap</p><p class="muted">The recap appears once this week is final.</p></section>`;
  const lines = [];
  if (r.high_team) lines.push(['High score', `${r.high_team.team.name}, ${fmt(r.high_team.points)} pts`]);
  if (r.top_player) lines.push(['Top player', `${r.top_player.name} (${r.top_player.team}), ${fmt(r.top_player.points)} pts`]);
  if (r.blowout) lines.push(['Biggest win', `${r.blowout.home.team.name} ${fmt(r.blowout.home.points)}, ${r.blowout.away.team.name} ${fmt(r.blowout.away.points)}`]);
  if (r.closest && r.games.length > 1) lines.push(['Closest game', `${r.closest.home.team.name} ${fmt(r.closest.home.points)}, ${r.closest.away.team.name} ${fmt(r.closest.away.points)}`]);
  return `<section class="card recap"><p class="eyebrow">Week ${r.week} recap</p>
    <div class="feed">${lines.map(([k, v]) => `<div class="feed-item"><b>${esc(k)}:</b> ${esc(v)}</div>`).join('')}</div></section>`;
}

// "Scores updated 3:42 PM", with a live note while games are on. Warns when the last pull is old during a game.
const STALE_AFTER_MS = 20 * 60 * 1000;
function scoreStamp(d) {
  if (!d || d.as_of === undefined) return '';
  if (!d.as_of) return '<p class="stamp">No scores yet. They appear after the first data pull.</p>';
  const when = new Date(d.as_of);
  const time = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (!d.live_games) return `<p class="stamp">Scores updated ${esc(time)}</p>`;
  const old = Date.now() - when.getTime() > STALE_AFTER_MS;
  const n = d.live_games;
  return `<p class="stamp live-line${old ? ' stale' : ''}" role="status"><span class="dot" aria-hidden="true"></span>${n} game${n === 1 ? '' : 's'} in progress · scores updated ${esc(time)}${old ? ' · may be behind' : ''}</p>`;
}

function scoresTab(d, detail, openIndex, recap) {
  const weeks = d.weeks;
  const first = weeks[0].week;
  const last = weeks[weeks.length - 1].week;
  const status = (weeks.find((x) => x.week === d.week) || {}).status;
  const points = d.format === 'points';
  let cards;
  if (points) cards = emptyNote('This is a points league. Standings rank teams by total points, so there are no weekly matchups.');
  else if (d.matchups.length) cards = d.matchups.map((m, i) => matchCard(m, i, openIndex === i, m.winner_team_id)).join('');
  else cards = emptyNote(detail.league.status === 'predraft' ? 'Scores start once the season does.' : 'No matchups for this week.');
  return `
  <div class="page-head"><div><h1>Scores</h1><p class="meta">${esc(weekLabel(d.week, weeks))}</p></div></div>
  <section class="card stepper">
    <button class="btn small" data-act="week" data-d="-1" ${d.week <= first ? 'disabled' : ''}>‹ Prev</button>
    <span class="step-label">Week ${d.week} · ${esc(status || '')}</span>
    <button class="btn small" data-act="week" data-d="1" ${d.week >= last ? 'disabled' : ''}>Next ›</button>
  </section>
  ${scoreStamp(d)}
  ${recap ? recapCard(recap) : ''}
  <div class="matchups">${cards}</div>`;
}

// ---- Draft -----------------------------------------------------------------

function draftLive(st, L) {
  if (st.status === 'complete') {
    return `<section class="card hero"><p class="eyebrow">Draft complete</p><p class="display">Rosters are set</p>
      <a class="btn primary" href="#/l/${L.id}/team">Go to your team</a></section>`;
  }
  const clock = st.on_clock;
  const mine = !!(clock && clock.is_me);
  const who = !clock ? 'Waiting' : mine ? 'You are on the clock' : `${clock.name} is on the clock`;
  const recent = st.picks.filter((p) => p.player).slice(-8).reverse();
  return `
  <section class="card hero clockcard ${mine ? 'mine' : ''}">
    <div class="clock">
      <div class="minw">
        <p class="eyebrow">Round ${st.round} · Pick ${st.current_pick} of ${st.total_picks}</p>
        <p class="clock-name">${esc(clock ? clock.name : '')}</p>
        <p class="muted small">${esc(who)}</p>
      </div>
      ${st.deadline ? `<div class="timer" data-deadline="${esc(st.deadline)}" aria-label="Time left">--:--</div>` : ''}
    </div>
    ${mine ? '<div class="actions"><button class="btn small" data-act="draft-auto">Pick best available</button></div>' : ''}
  </section>
  ${recent.length ? `<section>${sectionHead('Latest picks')}<div class="list">${recent.map((p) => `<div class="prow static">
      <span class="pick-n">${p.pick_no}</span>
      <div class="pmain"><div class="pname">${esc(p.player.name)}</div>
      <div class="psub">${esc(p.team.name)}${p.auto ? ' · auto' : ''}</div></div></div>`).join('')}</div></section>` : ''}`;
}

// Commissioner sets the order before the draft (everyone can see it)
function orderPanel(detail) {
  const L = detail.league;
  const anySet = detail.teams.some((t) => t.draft_slot);
  const teams = detail.teams.slice().sort((a, b) => (a.draft_slot || 99) - (b.draft_slot || 99) || a.id - b.id);
  const rows = teams.map((t, i) => `<div class="prow static">
      <span class="pick-n">${i + 1}</span>
      <div class="pmain"><div class="pname">${esc(t.name)}</div><div class="psub">${esc(t.owner)}</div></div>
      <div class="pright">${L.commissioner ? `<button class="btn small" data-act="order-move" data-tid="${t.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(t.name)} up">▲</button>
        <button class="btn small" data-act="order-move" data-tid="${t.id}" data-dir="1" ${i === teams.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(t.name)} down">▼</button>` : ''}</div>
    </div>`).join('');
  return `<section class="card"><h2>Draft order</h2>
    <p class="fine">${anySet ? 'Pick 1 goes first. Rounds snake back.' : 'Not set yet. The order is random when the draft starts.'}</p>
    <div class="list">${rows}</div>
    ${L.commissioner ? '<div class="actions"><button class="btn small" data-act="order-random">Shuffle order</button></div>' : ''}
  </section>`;
}

function queuePanel(queue) {
  const rows = queue.map((q, i) => `<div class="prow static ${q.taken ? 'taken' : ''}">
      <span class="pick-n">${i + 1}</span>
      <div class="pmain"><div class="pname">${esc(q.name)}</div>
        <div class="psub">${posTag(q.position)}<span class="truncate">${esc(q.school)}</span>${q.taken ? ' · taken' : ''}</div></div>
      <div class="pright">
        <button class="btn small" data-act="queue-move" data-pid="${esc(q.player_id)}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(q.name)} up">▲</button>
        <button class="btn small" data-act="queue-move" data-pid="${esc(q.player_id)}" data-dir="1" ${i === queue.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(q.name)} down">▼</button>
        <button class="btn small" data-act="queue-remove" data-pid="${esc(q.player_id)}" aria-label="Remove ${esc(q.name)} from queue">✕</button>
      </div></div>`).join('');
  return `<section class="card queue" id="queue-panel"><h2>Your queue</h2>
    <p class="fine">If your pick runs out of time, the first available player here is taken. Otherwise the best available is.</p>
    ${queue.length ? `<div class="list">${rows}</div>` : emptyNote('Your queue is empty. Tap Queue on a player below.')}
  </section>`;
}

function draftList(players, st, queued = new Set()) {
  if (st.status !== 'live') return '';
  const mine = !!(st.on_clock && st.on_clock.is_me);
  if (!players.length) return emptyNote('Nobody matches that search.');
  return `<div class="list">${players.map((p) => playerRow(p, {
    right: `<span class="rank">#${p.rank}</span><span class="small muted">proj ${fmt(p.projection)}</span>
      <div class="pair">
        <button class="btn small" data-act="queue-add" data-pid="${esc(p.id)}" ${queued.has(p.id) ? 'disabled' : ''} aria-label="Queue ${esc(p.name)}">${queued.has(p.id) ? 'Queued' : 'Queue'}</button>
        <button class="btn small ${mine ? 'primary' : ''}" data-act="draft-pick" data-pid="${esc(p.id)}" ${mine ? '' : 'disabled'}>Draft</button>
      </div>`
  })).join('')}</div>`;
}

function draftTab(st, detail, available, dstate, queue = []) {
  const L = detail.league;
  const head = `<div class="page-head"><div><h1>Draft room</h1><p class="meta">${esc(L.name)}</p></div></div>`;
  if (st.status === 'pending') {
    return `${head}
      <section class="card hero"><p class="eyebrow">Pre-draft</p><p class="display">Draft not started</p>
      ${L.commissioner
        ? '<button class="btn primary" data-act="start-draft">Start draft</button>'
        : `<p class="muted">The commissioner starts the draft. Each pick has a ${L.settings.pick_seconds}-second timer.</p>`}
      </section>
      ${orderPanel(detail)}
      ${queuePanel(queue)}`;
  }
  const queued = new Set(queue.map((q) => q.player_id));
  return `${head}
    <div id="draft-live">${draftLive(st, L)}</div>
    ${st.status === 'live' ? queuePanel(queue) : ''}
    <div class="chips" role="group" aria-label="Position">${['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DEF'].map((p) => chip('dpos', p, p === 'ALL' ? 'All' : p, dstate.dpos === p)).join('')}</div>
    <input class="search" data-input="dq" type="search" placeholder="Search players or schools" value="${esc(dstate.dq)}" aria-label="Search players" autocomplete="off">
    <div id="draft-avail">${draftList(available, st, queued)}</div>`;
}

// ---- Trades ----------------------------------------------------------------

function tradeCard(t, mode) {
  const names = (arr) => (arr.length ? arr.map((p) => esc(p.name)).join(', ') : 'nothing');
  let actions = pill(t.status, t.status === 'accepted' ? 'win' : 'muted');
  if (mode === 'in') {
    actions = `<button class="btn small primary" data-act="trade-accept" data-tid="${t.id}">Accept</button>
      <button class="btn small" data-act="trade-counter" data-tid="${t.id}">Counter</button>
      <button class="btn small" data-act="trade-decline" data-tid="${t.id}">Decline</button>`;
  } else if (mode === 'out') {
    actions = `<button class="btn small" data-act="trade-cancel" data-tid="${t.id}">Cancel</button>`;
  }
  return `<div class="card trade">
    <div class="fine">${esc(t.from.name)} with ${esc(t.to.name)}</div>
    <div><b>${esc(t.from.name)} sends</b> ${names(t.give)}</div>
    <div><b>${esc(t.from.name)} asks for</b> ${names(t.get)}</div>
    <div class="actions">${actions}</div>
  </div>`;
}

function tradeRow(p, side, selected) {
  return `<div class="prow ${selected ? 'sel' : ''}" role="checkbox" aria-checked="${selected}" tabindex="0"
      data-act="trade-toggle" data-side="${side}" data-pid="${esc(p.id)}">
    ${badge(p.team)}
    <div class="pmain"><div class="pname">${esc(p.name)}</div>
      <div class="psub">${posTag(p.position)}<span class="truncate">${esc(p.team.school)}</span></div></div>
    <span class="check" aria-hidden="true">${selected ? '✓' : ''}</span>
  </div>`;
}

function analyzerCard(p) {
  if (!p) return '';
  const names = (arr) => (arr.length ? arr.map((x) => esc(x.name)).join(', ') : 'nothing');
  return `<section class="card analyzer" aria-live="polite">
    <p class="eyebrow">Trade analyzer</p>
    <p class="display">${esc(p.verdict)}</p>
    <p class="muted small">Value ${signed(p.value_change)} · projection ${signed(p.projection_change)} for you</p>
    <p class="fine"><b>You send:</b> ${names(p.give)}<br><b>You get:</b> ${names(p.get)}</p>
  </section>`;
}

function tradesTab(trades, detail, tr, mine, theirs, extra = {}) {
  const L = detail.league;
  const incoming = trades.filter((t) => t.status === 'pending' && t.my_side === 'to');
  const outgoing = trades.filter((t) => t.status === 'pending' && t.my_side === 'from');
  const history = trades.filter((t) => t.status !== 'pending').slice(0, 10);
  const others = detail.teams.filter((t) => !t.is_me);
  const open = extra.open !== false;
  let builder = '';
  if (L.status === 'complete') {
    builder = '<p class="notice">This season is over, so trades are closed.</p>';
  } else if (L.status !== 'season') {
    builder = '<p class="notice">Trades open once the draft is complete.</p>';
  } else if (!open) {
    builder = `<p class="notice">Trades closed after week ${esc(extra.deadline_week)}.</p>`;
  } else {
    const teamChoices = `<div class="chips" role="group" aria-label="Trade partner">${others.map((t) =>
      `<button class="chip ${tr.to === t.id ? 'on' : ''}" data-act="trade-to" data-tid="${t.id}">${esc(t.name)}</button>`).join('')}</div>`;
    let body = '';
    if (tr.to && theirs && mine) {
      const giveSet = new Set(tr.give);
      const getSet = new Set(tr.get);
      const mineRows = mine.roster.map((r) => tradeRow(r.player, 'give', giveSet.has(r.player.id))).join('');
      const theirRows = theirs.roster.map((r) => tradeRow(r.player, 'get', getSet.has(r.player.id))).join('');
      const ready = tr.give.length + tr.get.length > 0;
      body = `${tr.counterOf ? '<p class="notice">Counter-offer. Sending it closes the trade you received.</p>' : ''}
        ${analyzerCard(extra.preview)}
        <div class="fine">You send ${tr.give.length} and receive ${tr.get.length}.</div>
        ${sectionHead('You send')}<div class="list">${mineRows}</div>
        ${sectionHead(`You receive from ${theirs.team.name}`)}<div class="list">${theirRows}</div>
        <button class="btn primary full" data-act="trade-propose" ${ready ? '' : 'disabled'}>${tr.counterOf ? 'Send counter-offer' : 'Propose trade'}</button>`;
    }
    builder = `<section class="card trade-builder"><h2>${tr.counterOf ? 'Counter-offer' : 'Propose a trade'}</h2>${teamChoices}${body}</section>`;
  }
  const list = (items, mode, title) => (items.length ? `<section>${sectionHead(title)}${items.map((t) => tradeCard(t, mode)).join('')}</section>` : '');
  return `
  <div class="page-head"><div><h1>Trades</h1><p class="meta">${L.settings.trade_deadline_week && open ? `Open through week ${L.settings.trade_deadline_week}` : 'Offers wait for the other team to answer'}</p></div></div>
  ${list(incoming, 'in', 'Waiting for you')}
  ${list(outgoing, 'out', 'Sent by you')}
  ${builder}
  ${history.length ? list(history, 'done', 'History') : ''}
  ${!trades.length && L.status === 'season' ? emptyNote('No trades yet.') : ''}`;
}

// ---- Chat ------------------------------------------------------------------

function chatLine(m, openId = null) {
  const reactions = (m.reactions || []).map((r) => `<button class="react ${r.mine ? 'on' : ''}" data-act="react" data-mid="${m.id}" data-emoji="${esc(r.emoji)}" aria-pressed="${r.mine}">${esc(r.emoji)} ${r.count}</button>`).join('');
  const picker = openId === m.id ? `<span class="picker">${REACTIONS.map((e) => `<button class="react" data-act="react" data-mid="${m.id}" data-emoji="${esc(e)}" aria-label="React ${esc(e)}">${esc(e)}</button>`).join('')}</span>` : '';
  return `<div class="msg ${m.mine ? 'mine' : ''}" data-mid="${m.id}">
    <div class="msg-author">${esc(m.author)}</div>
    <div class="msg-body">${esc(m.body)}</div>
    <div class="reactions">${reactions}<button class="react add" data-act="react-open" data-mid="${m.id}" aria-expanded="${openId === m.id}" aria-label="Add reaction">+</button>${picker}</div>
  </div>`;
}

function chatTab(messages, openId = null) {
  const lines = messages.length ? messages.map((m) => chatLine(m, openId)).join('') : emptyNote('No messages yet. Say hello.');
  return `
  <div class="page-head"><div><h1>Chat</h1><p class="meta">Everyone in the league</p></div></div>
  <div id="chat-log" class="chat-log">${lines}</div>
  <form class="composer" data-form="chat">
    <input name="body" maxlength="500" placeholder="Message the league" autocomplete="off" required aria-label="Message">
    <button class="btn primary small" type="submit">Send</button>
  </form>`;
}

// ---- Settings --------------------------------------------------------------

function ruleList(s) {
  const rows = [
    ['Teams', s.team_count],
    ['Scoring format', s.format === 'points' ? 'Season points' : 'Weekly head-to-head'],
    ['Regular season', `${s.regular_weeks} weeks`],
    ['Playoffs', s.playoff_teams && s.format !== 'points' ? '4 teams' : 'None'],
    ['Waivers', s.waiver_mode === 'faab' ? `FAAB, $${s.faab_budget} each` : 'Priority order'],
    ['Trade deadline', s.trade_deadline_week ? `Through week ${s.trade_deadline_week}` : 'None'],
    ['Best ball', s.best_ball ? 'On' : 'Off'],
    ['Pick timer', `${s.pick_seconds} seconds`]
  ];
  return rows.map(([k, v]) => `<div class="grow"><span class="gw"></span><span class="gline">${esc(k)}</span><span class="gp small">${esc(v)}</span></div>`).join('');
}

// Commissioner only: remove a member. Their team goes to a CPU.
function membersCard(detail) {
  const L = detail.league;
  const humans = detail.teams.filter((t) => !t.is_cpu && !t.is_me);
  const after = L.status === 'predraft'
    ? 'Before the draft, the invite code can fill the seat again.'
    : 'After the draft, only a freed team can be joined with the invite code.';
  const rows = humans.length
    ? humans.map((t) => `<div class="prow static"><div class="pmain"><div class="pname">${esc(t.owner)}</div>
        <div class="psub">${esc(t.name)}</div></div>
        <div class="pright"><button class="btn small danger" data-act="release-member" data-tid="${t.id}" data-name="${esc(t.owner)}">Remove</button></div></div>`).join('')
    : emptyNote('No other members yet.');
  return `<section class="card members"><h2>Members</h2>
    <p class="fine">Removing someone hands their team to a CPU and closes their open trades and waiver claims. ${after}</p>
    <div class="list">${rows}</div></section>`;
}

// Everyone: a note to the people who run the app. Saved on the server.
function helpCard(meta, leagueId) {
  const mail = meta && meta.support_email
    ? `<p class="fine">Email <a href="mailto:${esc(meta.support_email)}">${esc(meta.support_email)}</a>, or send a note here.</p>`
    : '<p class="fine">Send a note here. It reaches the person who runs this app.</p>';
  return `<form class="card form" data-form="feedback" data-league="${leagueId}">
    <h2>Help</h2>
    ${mail}
    <label class="field"><span>What went wrong, or what should we add?</span>
      <textarea name="body" rows="4" maxlength="1000" required placeholder="What were you doing, and what happened?"></textarea></label>
    <p class="form-error" role="alert"></p>
    <button class="btn small" type="submit">Send</button>
  </form>`;
}

function settingsTab(detail, meta = {}) {
  const L = detail.league;
  const s = L.settings;
  const rename = `<form class="card form" data-form="rename-team">
      <h2>Your team</h2>
      ${textField({ name: 'name', label: 'Team name', value: L.my_team ? L.my_team.name : '', required: true, maxlength: 40 })}
      <button class="btn small" type="submit">Save team name</button></form>`;
  if (!L.commissioner) {
    return `<div class="page-head"><div><h1>Settings</h1><p class="meta">League rules</p></div></div>
      <section class="card">${ruleList(s)}</section>
      <section class="card"><h2>Scoring</h2>${SCORING_FIELDS.map(([k, label, unit]) => `<div class="grow"><span class="gw"></span>
        <span class="gline">${esc(label)} <span class="muted">${esc(unit)}</span></span><span class="gp small">${fmt(s.scoring[k], 2)}</span></div>`).join('')}</section>
      ${rename}${helpCard(meta, L.id)}`;
  }
  const locked = L.status !== 'predraft';
  const league = locked
    ? `<section class="card"><p class="notice">Rules lock once the draft starts.</p><section class="card">${ruleList(s)}</section></section>`
    : `<form class="card form" data-form="league-settings">
      <h2>League rules</h2>
      ${ruleFields(s, { withName: true, name: L.name })}
      <h2>Scoring</h2>
      ${SCORING_FIELDS.map(([k, label, unit]) => `<label class="field"><span>${esc(label)} <span class="muted">${esc(unit)}</span></span>
        <input name="scoring_${k}" type="number" step="0.01" value="${esc(s.scoring[k])}" required></label>`).join('')}
      <p class="form-error" role="alert"></p>
      <button class="btn primary full" type="submit">Save settings</button>
    </form>`;
  return `<div class="page-head"><div><h1>Settings</h1><p class="meta">Commissioner</p></div></div>
    <section class="card invite"><div><p class="eyebrow">Invite code</p><p class="display invite-code">${esc(L.invite_code)}</p></div>
      <button class="btn small" data-act="copy-code" data-code="${esc(L.invite_code)}" data-label="Invite code copied">Copy</button></section>
    ${league}${membersCard(detail)}${rename}${helpCard(meta, L.id)}`;
}

// ---- Sheets ----------------------------------------------------------------

function sheetShell(label, inner) {
  return `<div class="backdrop" data-act="close" aria-hidden="true"></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(label)}">
      <div class="grab" aria-hidden="true"></div>${inner}</div>`;
}

function playerSheet(sh, mine, detail) {
  const d = sh.data;
  const p = d.player;
  const L = detail.league;
  const entry = mine ? mine.roster.find((r) => r.player.id === p.id) : null;
  const onMine = !!entry;
  const status = onMine ? 'On your team' : d.owner ? `Owned by ${d.owner.name}` : 'Free agent';
  const season = d.games.reduce((a, g) => a + g.points, 0);
  const open = L.status === 'season';
  const locked = !!(d.game && d.game.locked) || !!(entry && entry.locked);
  const bestBall = !!(mine && mine.best_ball);
  const faab = L.settings.waiver_mode === 'faab';
  const balance = mine ? mine.faab : 0;
  const actions = [];
  if (open && onMine && !locked && !bestBall) {
    const options = mine.slots.filter((s) => s.eligible.includes(p.position) && s.key !== entry.slot);
    if (entry.slot !== 'BN') actions.push(`<button class="btn small" data-act="move" data-pid="${esc(p.id)}" data-slot="BN">Bench</button>`);
    for (const s of options) actions.push(`<button class="btn small primary" data-act="move" data-pid="${esc(p.id)}" data-slot="${esc(s.key)}">Start at ${esc(s.key)}</button>`);
    actions.push(`<button class="btn small danger" data-act="drop" data-pid="${esc(p.id)}">Drop</button>`);
  } else if (open && onMine && !locked) {
    actions.push(`<button class="btn small danger" data-act="drop" data-pid="${esc(p.id)}">Drop</button>`);
  } else if (open && !d.owner) {
    actions.push(`<button class="btn small primary" data-act="quick-add" data-pid="${esc(p.id)}">Add</button>`);
    actions.push(`<button class="btn small" data-act="claim" data-pid="${esc(p.id)}">Waiver claim</button>`);
  } else if (d.owner && !onMine) {
    actions.push(`<a class="btn small" href="#/l/${L.id}/trades">Propose a trade</a>`);
  }
  const bidField = open && !d.owner && faab && !onMine
    ? `<label class="field"><span>Your bid (you have $${esc(balance)})</span>
        <input id="claim-bid" type="number" min="0" max="${esc(balance)}" step="1" value="0" inputmode="numeric"></label>
        <p class="fine">Add takes him now. A claim waits until the week closes, and the highest bid wins.</p>`
    : '';
  const log = d.games.length
    ? d.games.slice().reverse().map((g) => `<div class="grow">
        <span class="gw">${g.season_type === 'postseason' ? 'Bowl' : 'W' + g.week}</span>
        <span class="gline">${esc(g.line)}</span><span class="gp">${fmt(g.points)}</span></div>`).join('')
    : emptyNote('No games played yet.');
  let note = '';
  if (!open) note = '<p class="fine">Roster moves open once the draft is complete.</p>';
  else if (locked) note = `<p class="lock">Locked. ${esc(p.school || p.team.school)}'s game is underway, so this player can't move or be dropped until it ends.</p>`;
  else if (d.game && d.game.start && !d.game.completed) note = `<p class="fine">Kicks off ${esc(kickoffText(d.game.start))}. He locks then.</p>`;
  else if (bestBall && onMine) note = '<p class="fine">Best ball: the app sets this lineup for you.</p>';
  return sheetShell(p.name, `
    <div class="sheet-head">${badge(p.team, 'big')}
      <div class="minw"><h3 class="sheet-name">${esc(p.name)}</h3>
        <div class="psub">${posTag(p.position)}<span>${esc(p.team.school)}</span></div></div></div>
    <div class="stats3">
      <div><span class="k">Projected</span><b>${fmt(d.projection)}</b></div>
      <div><span class="k">Season</span><b>${fmt(season)}</b></div>
      <div><span class="k">Status</span><span class="small-val">${esc(status)}</span></div>
    </div>
    ${note}
    ${injuryLine(p)}
    ${bidField}
    ${actions.length ? `<div class="actions">${actions.join('')}</div>` : ''}
    <section><div class="section-row"><h2>Game log</h2></div>${log}</section>`);
}

function dropSheet(sh, mine) {
  const rows = mine.roster.map((r) => {
    const blocked = r.locked;
    return `<div class="prow ${blocked ? 'taken' : ''}" role="button" tabindex="0" ${blocked ? 'aria-disabled="true"' : ''}
      data-act="${sh.mode === 'claim' ? 'claim-drop' : 'add-drop'}" data-pid="${esc(sh.pid)}" data-drop="${esc(r.player.id)}" data-bid="${esc(sh.bid || 0)}">
      ${badge(r.player.team)}
      <div class="pmain"><div class="pname">${esc(r.player.name)}</div>
        <div class="psub">${posTag(r.player.position)}<span class="truncate">${esc(r.player.team.school)}</span>${blocked ? ' · locked' : ''}</div></div>
      <div class="pright"><span class="pts">${fmt(r.projection)}</span></div></div>`;
  }).join('');
  return sheetShell('Choose a player to drop', `
    <h3 class="sheet-name">Make room for ${esc(sh.name)}</h3>
    <p class="fine">Your roster is full. Choose who to drop${sh.mode === 'claim' ? ' when the claim goes through' : ''}. Locked players can't be dropped.</p>
    <div class="list">${rows}</div>
    <div class="actions"><button class="btn small" data-act="close">Cancel</button></div>`);
}

