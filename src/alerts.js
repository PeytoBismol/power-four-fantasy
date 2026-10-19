'use strict';

// What needs a coach's attention now. The league screen gets this with every poll, so it stays cheap.
// Each alert names the tab where the fix happens, so the screen can link straight to it.
//   now   the coach is on the clock in the draft
//   warn  a starter is out or doubtful, a starting slot is empty, or the trade deadline is this week
//   soon  a starter's game kicks off within the hour, so he locks then
//   info  trade offers are waiting for an answer
// There are no push notifications in this app: alerts show when the coach opens the league.

const { BENCH } = require('./config');
const L = require('./league');
const draft = require('./draft');
const season = require('./season');

const SOON_MS = 60 * 60 * 1000;

function alertsFor(db, league, team, user, now = Date.now()) {
  const alerts = [];
  const add = (level, kind, tab, message) => alerts.push({ level, kind, tab, message });

  if (league.status === 'drafting') {
    const st = draft.draftState(db, league, user.id);
    if (st.on_clock && st.on_clock.is_me) {
      add('now', 'on_clock', 'draft', `You're on the clock: pick ${st.current_pick} of ${st.total_picks}, round ${st.round}.`);
    }
  }
  if (league.status !== 'season') return alerts;

  const week = season.currentWeek(db, league.season);
  const kickoffs = L.kickoffsForWeek(db, league.season, week);
  const soon = [];
  for (const r of L.rosterRows(db, team.id)) {
    if (r.slot === BENCH) continue;
    const info = kickoffs.get(r.team_id);
    if (!info || info.completed || !info.start) continue;
    const untilKickoff = Date.parse(info.start) - now;
    if (untilKickoff > 0 && untilKickoff <= SOON_MS) soon.push(r.name);
  }
  if (soon.length) {
    add('soon', 'lock_soon', 'team', `${soon.join(', ')} ${soon.length === 1 ? 'kicks' : 'kick'} off within the hour and locks then.`);
  }
  for (const w of L.lineupWarnings(db, league, team, week)) {
    if (w.kind === 'injured' || w.kind === 'empty') add('warn', w.kind, 'team', w.message);
  }

  const incoming = db.prepare("SELECT COUNT(*) AS n FROM trades WHERE league_id = ? AND to_team_id = ? AND status = 'pending'")
    .get(league.id, team.id).n;
  if (incoming) {
    add('info', 'trade_offer', 'trades', `${incoming} trade offer${incoming === 1 ? ' is' : 's are'} waiting for your answer.`);
  }
  const deadline = league.settings.trade_deadline_week;
  if (deadline && week === deadline) add('warn', 'deadline', 'trades', 'Trades close after this week.');
  return alerts;
}

module.exports = { alertsFor };
