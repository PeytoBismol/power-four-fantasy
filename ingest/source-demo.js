'use strict';

// Offline stand-in for the CFBD client. It returns the same shapes the live API returns, so the real
// transform and ingest code run unchanged. Seeded: the same run always produces the same league.

const { POWER_FOUR, OTHER_FBS } = require('./demo-schools');

const PLAYED_THROUGH_WEEK = 6;   // weeks 1-6 are final, week 7 is scheduled
const SCHEDULED_WEEKS = 7;

const FIRST = ['Jalen', 'Marcus', 'Tyler', 'Caleb', 'Dylan', 'Jordan', 'Malik', 'Carter', 'Ethan', 'Brandon', 'Darius', 'Ryan', 'Noah', 'Cole', 'Trey', 'Jaden', 'Kendrick', 'Miles', 'Owen', 'Reggie', 'Deshawn', 'Luke', 'Tyson', 'Garrett', 'Chase', 'Andre', 'Xavier', 'Jace', 'Kyle', 'Terrell', 'Bryce', 'Elijah', 'Gabe', 'Josiah', 'Nate'];
const LAST = ['Walker', 'Brooks', 'Hayes', 'Coleman', 'Reed', 'Mitchell', 'Bennett', 'Porter', 'Simmons', 'Ford', 'Turner', 'Bailey', 'Crawford', 'Hughes', 'Patterson', 'Sanders', 'Foster', 'Powell', 'Rivera', 'Gordon', 'Russell', 'Griffin', 'Diaz', 'Hunter', 'Shaw', 'Perry', 'Price', 'Long', 'Howard', 'Cooper', 'Ware', 'Dixon', 'Lowe', 'Mason', 'Barnes', 'Pruitt', 'Keller'];

// Roster shape per school (CFBD position codes; K is PK on some schools, FB and ATH feed the RB and WR logic)
const ROSTER_PLAN = [['QB', 3], ['RB', 4], ['FB', 1], ['WR', 6], ['TE', 3], ['K', 1], ['P', 1], ['OL', 8], ['DL', 6], ['LB', 4], ['DB', 6], ['ATH', 1]];

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (arr, r) => arr[Math.floor(r() * arr.length)];

// Placeholder colors: distinct per school, clearly generated. Live data carries the real ones.
function hsl(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  const hex = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`.toUpperCase();
}

function buildWorld(year) {
  const teams = [
    ...POWER_FOUR.map((t, i) => ({ ...t, id: 100 + i })),
    ...OTHER_FBS.map((t, i) => ({ ...t, id: 300 + i }))
  ].map((t) => {
    const h = hashStr(t.school) % 360;
    return { ...t, mascot: null, color: hsl(h, 0.6, 0.34), alt_color: hsl((h + 150) % 360, 0.7, 0.62) };
  });
  const bySchool = new Map(teams.map((t) => [t.school, t]));
  const byId = new Map(teams.map((t) => [t.id, t]));
  const rosters = new Map();
  for (const t of teams.filter((x) => POWER_FOUR.some((p) => p.school === x.school))) {
    const r = mulberry32(hashStr('roster:' + t.school));
    const list = [];
    let n = 0;
    for (const [code, count] of ROSTER_PLAN) {
      for (let i = 0; i < count; i++) {
        n++;
        const position = code === 'K' && t.id % 5 === 0 ? 'PK' : code;
        list.push({
          id: 100000 + t.id * 100 + n,
          first_name: pick(FIRST, r),
          last_name: pick(LAST, r),
          position,
          jersey: 1 + Math.floor(r() * 98),
          team: t.school
        });
      }
    }
    rosters.set(t.school, list);
  }
  const games = [];
  for (let week = 1; week <= SCHEDULED_WEEKS; week++) {
    const r = mulberry32(hashStr('week:' + week));
    const order = teams.map((t) => t.id);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const played = week <= PLAYED_THROUGH_WEEK;
    for (let i = 0; i + 1 < order.length; i += 2) {
      const home = byId.get(order[i]);
      const away = byId.get(order[i + 1]);
      games.push({
        id: 4000000 + week * 1000 + i / 2,
        season: year,
        week,
        season_type: 'regular',
        // Unplayed games have no kickoff time (as an unscheduled game would not), so they do not lock lineups
        start_date: played ? new Date(Date.UTC(year, 7, 29 + (week - 1) * 7, 19)).toISOString() : null,
        completed: played,
        home_id: home.id,
        home_team: home.school,
        home_conference: home.conference,
        home_points: played ? 10 + Math.floor(r() * 35) : null,
        away_id: away.id,
        away_team: away.school,
        away_conference: away.conference,
        away_points: played ? 10 + Math.floor(r() * 35) : null
      });
    }
  }
  return { teams, bySchool, byId, rosters, games };
}

// One school's categories for one game, in the shape /games/players returns
function categoriesFor(world, team, gameId) {
  const r = mulberry32(hashStr(`box:${gameId}:${team.id}`));
  const roster = world.rosters.get(team.school);
  const by = (codes) => roster.filter((p) => codes.includes(p.position));
  const qbs = by(['QB']);
  const backs = by(['RB', 'FB', 'ATH']);
  const wrs = by(['WR', 'ATH']);
  const tes = by(['TE']);
  const ks = by(['K', 'PK']);
  const pun = by(['P']);
  const front = by(['DL', 'LB']);
  const dbs = by(['DB']);
  const QB = pick(qbs, r);
  const rows = [];
  const add = (cat, type, p, stat) => rows.push({ cat, type, p, stat: String(stat) });

  const attempts = 18 + Math.floor(r() * 25);
  const completions = Math.round(attempts * (0.5 + r() * 0.25));
  add('passing', 'C/ATT', QB, `${completions}/${attempts}`);
  add('passing', 'YDS', QB, Math.round(attempts * (5 + r() * 6)));
  if (r() < 0.8) add('passing', 'TD', QB, Math.floor(r() * 4));
  if (r() < 0.35) add('passing', 'INT', QB, 1);

  const rb1 = backs[0];
  const rb2 = backs[1];
  const car1 = 10 + Math.floor(r() * 16);
  add('rushing', 'CAR', rb1, car1);
  add('rushing', 'YDS', rb1, Math.round(car1 * (3 + r() * 4)));
  if (r() < 0.4) add('rushing', 'TD', rb1, 1);
  const car2 = 3 + Math.floor(r() * 6);
  add('rushing', 'CAR', rb2, car2);
  add('rushing', 'YDS', rb2, Math.round(car2 * (2 + r() * 4)));
  add('rushing', 'CAR', QB, 2);
  add('rushing', 'YDS', QB, 9);

  const targets = [wrs[0], wrs[1], wrs[2], tes[0], rb1];
  const shares = [0.3, 0.2, 0.15, 0.15, 0.1];
  targets.forEach((p, i) => {
    const rec = Math.max(0, Math.floor(completions * shares[i]));
    if (!rec) return;
    add('receiving', 'REC', p, rec);
    add('receiving', 'YDS', p, Math.round(rec * (8 + r() * 10)));
    if (r() < 0.25) add('receiving', 'TD', p, 1);
  });
  if (r() < 0.06) add('fumbles', 'LOST', rb2, 1);

  const k = ks[0];
  if (k) {
    const fga = 1 + Math.floor(r() * 4);
    const fgm = Math.max(0, fga - Math.floor(r() * 2));
    add('kicking', 'FG', k, `${fgm}/${fga}`);
    const xp = 1 + Math.floor(r() * 4);
    add('kicking', 'XP', k, `${xp}/${xp}`);
  }
  if (pun[0]) add('punting', 'NO', pun[0], 3 + Math.floor(r() * 3));

  for (const p of front.slice(0, 3)) {
    if (r() < 0.6) add('defensive', 'SACKS', p, r() < 0.5 ? '1.0' : '0.5');
  }
  if (r() < 0.3) add('defensive', 'TD', dbs[0], 1);
  for (const p of dbs.slice(0, 2)) {
    if (r() < 0.35) add('interceptions', 'INT', p, 1);
  }
  if (r() < 0.15) add('interceptions', 'TD', dbs[1], 1);
  // A player who transferred in is not on this roster yet, so the ingest has to create him from the box score
  if (r() < 0.05) {
    const transfer = { id: 900000 + team.id * 10, first_name: 'Transfer', last_name: 'Receiver' };
    add('receiving', 'REC', transfer, 2);
    add('receiving', 'YDS', transfer, 24);
  }

  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.cat)) grouped.set(row.cat, new Map());
    const types = grouped.get(row.cat);
    if (!types.has(row.type)) types.set(row.type, []);
    types.get(row.type).push({ id: row.p.id, name: `${row.p.first_name} ${row.p.last_name}`, stat: row.stat });
  }
  return [...grouped].map(([name, types]) => ({
    name,
    types: [...types].map(([type, athletes]) => ({ name: type, athletes }))
  }));
}

function createDemoSource({ year = 2026 } = {}) {
  const world = buildWorld(year);
  const sideFor = (game, team, homeAway) => {
    const power = world.rosters.has(team.school);
    return {
      school: team.school,
      conference: team.conference,
      homeAway,
      points: homeAway === 'home' ? game.home_points : game.away_points,
      categories: power ? categoriesFor(world, team, game.id) : []
    };
  };
  return {
    async teamsFbs() {
      return world.teams.map((t) => ({
        id: t.id,
        school: t.school,
        mascot: t.mascot,
        abbreviation: t.abbreviation,
        conference: t.conference,
        color: t.color,
        alt_color: t.alt_color
      }));
    },
    async roster(school) {
      return (world.rosters.get(school) || []).map((p) => ({ ...p }));
    },
    async games(_year, seasonType, week) {
      if (seasonType !== 'regular') return [];
      return world.games.filter((g) => g.week === week).map((g) => ({ ...g }));
    },
    async gamePlayers(_year, seasonType, week) {
      if (seasonType !== 'regular') return [];
      return world.games
        .filter((g) => g.week === week && g.completed)
        .map((g) => ({
          id: g.id,
          teams: [sideFor(g, world.byId.get(g.home_id), 'home'), sideFor(g, world.byId.get(g.away_id), 'away')]
        }));
    }
  };
}

module.exports = { createDemoSource, PLAYED_THROUGH_WEEK };
