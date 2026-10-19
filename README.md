# Power Four Fantasy

Sleeper-style fantasy football for the SEC, Big Ten, Big 12, ACC and Notre Dame.

- Snake draft with a pick timer, a commissioner-set draft order, and a personal draft queue
- Head-to-head weekly matchups, or a season points league with no matchups
- Starting lineup of QB, RB, RB, WR, WR, TE, WRT, K and DEF, with a 6-player bench
- Per-game lineup locks: each player locks when his school kicks off
- Lineup warnings before each week (empty slots, a better bench player)
- Free agents (instant add), waiver claims with priority order or sealed FAAB bids
- Trades with a trade analyzer, counter-offers and an optional trade deadline
- Best-ball leagues where the app sets every lineup
- Power rankings, weekly recaps, season awards, activity feed and past seasons
- League chat with emoji reactions
- Mid-season transfers and departures are handled automatically
- Team badges in each school's own colors, from the CFBD team data
- Light, dark, or match-the-phone appearance

Everything runs in one Node process: a JSON API, the web app, and a SQLite database. There are no npm dependencies.

## Requirements

- **Node.js 22.13 or newer** (uses the built-in `node:sqlite`). Node prints an `ExperimentalWarning` for it; the scripts hide that warning.
- A free **College Football Data (CFBD) API key**: https://collegefootballdata.com/key

## Windows

Run these in PowerShell from the project folder. The same `npm` commands work on Mac and Linux.

First time, the setup script installs everything, sets up the test browser, and runs the tests:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows-setup.ps1
```

If PowerShell says running scripts is disabled, use `npm.cmd` in place of `npm`, or run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.

The full routine for testing (after every change, before a deploy, and on a phone) is in [TESTING.md](TESTING.md).

## Quick start with demo data (no key needed)

```bash
npm run ingest:demo      # offline synthetic data in the same shape as CFBD
npm run demo             # creates demo@powerfour.local and a finished demo league; prints a password
npm start                # http://localhost:8080
```

Demo school colors are placeholders. Live data uses CFBD's colors. Demo games that have not been played have no kickoff time, so no players lock early in those weeks.

## Live setup with your CFBD key

1. Copy the example file and add your key. Do not paste the key into chat, email or a commit.

   ```bash
   cp .env.example .env        # Windows: copy .env.example .env
   # edit .env and set CFBD_API_KEY=...
   ```

2. Check the live API first. This lists the team and stat names the app maps, and any it does not yet map:

   ```bash
   npm run ingest:probe
   ```

   If it reports unmapped stat types, they are ignored until mapped in `ingest/transform.js`. Required stats missing from the probe are listed as errors.

3. Load the season:

   ```bash
   npm run ingest
   ```

   This loads the 68 teams (16 SEC, 18 Big Ten, 16 Big 12, 17 ACC, plus Notre Dame), their rosters, the schedule, kickoff times, and box-score stats for every week that has been played. Re-running is safe; it replaces each week's stats and reconciles rosters.

4. Start the app with `npm start` and create a league from the web app.

Run `npm run status` at any time to see the season week, row counts, the last ingest and the last backup.

## Keeping the season current

**Scheduled ingest (built in).** While the server runs, it refreshes stats every `INGEST_HOURS` hours. The default is 12 when `CFBD_API_KEY` is set, and off otherwise. Each run re-reads rosters and box scores, and the log prints how many CFBD requests it made. If you are near your plan's limit, raise `INGEST_HOURS`. A failed run is recorded and shown in `npm run status`; it does not stop the server.

Demo data is never overwritten by a scheduled run.

**Live scores (built in).** While games are on, the server refreshes the week in play every `LIVE_SCORE_MINUTES` minutes. The default is 10 with a key, `0` turns it off, and the smallest allowed value is 5. A game counts as live from one hour before kickoff until six hours after, or until it is final. The live refresh reads only that week's games and box scores, so one refresh is about two CFBD requests, and the server makes no extra calls between game windows. The scores tab and Home say how many games are in progress and when scores were last updated. After 20 minutes without an update they say the scores may be behind.

**Quota math.** Requests per day are roughly the full refreshes (each run's count is in the log) plus two requests for every live refresh. A Saturday with four hours of games at the default 10 minutes is about 24 live refreshes, or roughly 50 requests. Check the monthly limit on your CFBD plan, because this app does not read it. If you are close, raise `LIVE_SCORE_MINUTES`, or set it to `0` for weeks you do not need live scores.

**Closing weeks.** When every game in a fantasy week is final, ingest closes that week automatically: it locks the lineups, processes waiver claims, seeds the playoffs and sets CPU lineups. Turn this off with `AUTO_ADVANCE=0` or `--no-advance`, and close weeks yourself with:

```bash
npm run advance                                              # from the server
curl -X POST -H "X-Admin-Token: $ADMIN_TOKEN" https://your-host/api/admin/advance
```

League week mapping: league weeks 1 to 15 are CFBD regular-season weeks (week 15 is conference championship week). Playoff weeks use CFBD postseason weeks 1 to 4.

If you prefer cron to the built-in schedule, set `INGEST_HOURS=0` and use an entry like:

```cron
0 */6 * * * cd /srv/power-four && /usr/bin/node --disable-warning=ExperimentalWarning ingest/ingest.js >> /var/log/pf-ingest.log 2>&1
```

## Accounts and recovery codes

When you sign up, the app shows a **recovery code** once, for example `ABCD-EFGH-JKMN-PQRS`. Keep it somewhere safe. It is stored only as a hash.

- **Forgot your password?** On the sign-in page, choose *Forgot your password?*, then enter your email, the recovery code and a new password. You are signed in and given a new recovery code. The old one stops working.
- **Make a new code.** On the leagues page, open *Recovery code*, enter your current password and choose *Get a new recovery code*.
- **Accounts created before recovery codes existed** have no code. An admin on the server can set a new password and get a code with:

  ```bash
  npm run reset-password -- you@example.com "a-new-password"
  ```

  This also signs out every session for that account.

## Backups and restore

The database is backed up automatically every `BACKUP_HOURS` hours (default 24; `0` turns it off). Backups are written to `BACKUP_DIR`, which defaults to a `backups` folder next to the database. Only the newest `BACKUP_KEEP` (default 14) are kept.

```bash
npm run backup        # make a backup now
npm run status        # shows the last backup time
```

**Restoring a backup on this PC or a server**

1. Stop the server.
2. Copy the backup you want over the database file (`DB_PATH`).
3. Delete the `power-four.sqlite-wal` and `power-four.sqlite-shm` files next to it, if they exist. The database runs in WAL mode, and stale journal files would undo the restore.
4. Start the server again and sign in to check your leagues.

**Backups and the Fly volume.** On Fly, backups are saved on the same volume as the database, so they do not protect you from losing that volume. Copy them off the volume regularly, for example:

```bash
fly ssh sftp get /app/data/backups/<backup-file>.sqlite ./backups/
```

Test this once on a scratch app before you rely on it, and test a restore too.

## Put it online and install on your phone

**Why a server?** A domain name only points a web address at a computer. Something still has to run all the time to hold the database, check lineups and trades, run draft timers and close weeks. Free static hosts (GitHub Pages, Netlify static sites) can only serve files, so they can't run this app. You don't need a dedicated physical server, just a small cloud machine that stays on.

**Hosting options** (prices checked October 2026; confirm on each site):

| Option | Cost | Notes |
| --- | --- | --- |
| **Fly.io** (recommended) | About $4.40/month for 512 MB, plus $0.15/GB/month for the volume | Runs the included Dockerfile, gives you HTTPS on a `*.fly.dev` address, and keeps the database on a volume. Needs a card on file. |
| Render | Free tier, or $7/month and up for paid | Free services sleep when idle, and the database needs a disk that survives restarts. Paid disks cost $0.25/GB/month. |
| Small VPS (Hetzner, DigitalOcean, Vultr) | About $4–6/month | Cheapest long-term. You set up Docker and HTTPS yourself (Caddy makes HTTPS easy). |

A custom domain is optional. The `*.fly.dev` address works on phones and browsers with HTTPS.

**Deploy to Fly.io** (run these in a terminal in the project folder; you type your key there, don't paste it into chat). On Windows, install flyctl in PowerShell with `pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"` (use `powershell` in place of `pwsh` if `pwsh` isn't found), then close and reopen PowerShell. The `curl` line below is for Mac and Linux; the other commands work the same in PowerShell.

```bash
curl -L https://fly.io/install.sh | sh        # install flyctl, then log in: fly auth signup
# edit fly.toml and change `app` to a unique name
fly apps create <your-app-name>
fly volumes create pf_data --size 1 --region iad
fly secrets set ADMIN_TOKEN=<a-long-random-string-16-plus-characters> CFBD_API_KEY=<your-cfbd-key>
fly deploy
fly ssh console -C "node --disable-warning=ExperimentalWarning ingest/ingest.js"   # loads the season
```

Then open `https://<your-app-name>.fly.dev`. Scheduled ingest refreshes stats while the app runs (see *Keeping the season current*), so you rarely need the last command again. The `fly.toml` file is written from the project's configuration but has not been run against Fly in this build, so if a `fly` command reports an error, paste the message and it can be fixed.

**Install on your phone (Add to Home Screen)**

- **iPhone:** open the site in **Safari** (not Chrome, which can't install apps on iOS). Tap Share, then **Add to Home Screen**.
- **Android:** open the site in Chrome. Tap the menu (⋮), then **Install app** or **Add to Home screen**.

The app opens full screen with its own icon. Sign in with the same account on your phone and in a browser to see the same leagues. The app shell is cached so it opens quickly. League data is always live, so you need a connection to use it.

## Deploying

Environment variables (see `.env.example`):

| Variable | Purpose |
| --- | --- |
| `CFBD_API_KEY` | Your CFBD key. Needed for ingest only. |
| `SEASON` | Season to load and play. Default `2026`. |
| `PORT` | Port to listen on. Default `8080`. |
| `HOST` | Interface to bind. Default `0.0.0.0`. Use `127.0.0.1` behind a reverse proxy. |
| `DB_PATH` | SQLite file. Put it on a persistent volume. Default `data/power-four.sqlite`. |
| `COOKIE_SECURE` | Set to `1` when served over HTTPS so the session cookie is marked Secure. |
| `ADMIN_TOKEN` | At least 16 characters. Required to close weeks through the admin endpoint. |
| `AUTO_ADVANCE` | `0` to stop ingest from closing weeks automatically. |
| `INGEST_HOURS` | Hours between scheduled stats refreshes while the server runs. Default 12 with a key, otherwise `0` (off). |
| `BACKUP_HOURS` | Hours between automatic backups. Default `24`. `0` turns them off. |
| `BACKUP_DIR` | Where backups are written. Default: a `backups` folder next to the database. |
| `BACKUP_KEEP` | How many backups to keep. Default `14`. |
| `LIVE_SCORE_MINUTES` | Minutes between live-score refreshes while games are on. Default 10 with a key, otherwise `0` (off). The smallest value is 5. |
| `SUPPORT_EMAIL` | Address shown on the sign-in page and the Help card. No default. |

Put the app behind HTTPS (a reverse proxy such as Caddy or nginx), set `COOKIE_SECURE=1`, and keep `data/` on disk that survives restarts.

Docker (optional. `fly deploy` builds the image for you, so you only need this to run the image yourself):

```bash
docker build -t power-four-fantasy .
docker run -d -p 8080:8080 \
  -v pf-data:/app/data \
  -e COOKIE_SECURE=1 -e ADMIN_TOKEN=change-this-to-a-long-random-string \
  power-four-fantasy
# load data into the same volume (needs your key):
docker run --rm -v pf-data:/app/data --env-file .env power-four-fantasy \
  node --disable-warning=ExperimentalWarning ingest/ingest.js
```

## Scoring and rules

Default scoring (every value can be changed by the commissioner before the draft, in Settings):

| Stat | Points |
| --- | --- |
| Passing yards | 0.04 per yard |
| Passing TD | 4 |
| Interception thrown | -2 |
| Rushing yards / receiving yards | 0.1 per yard |
| Rushing TD / receiving TD | 6 |
| Reception | 1 (PPR) |
| Fumble lost | -2 |
| Field goal / extra point | 3 / 1 |
| Sack / interception / defensive TD | 1 / 2 / 6 |
| Defense points allowed | 10 (0), 7 (1-6), 4 (7-13), 1 (14-20), 0 (21-27), -1 (28-34), -4 (35+) |

Each school has a DEF player that scores its defensive plays and points allowed.

**League settings** (set by the commissioner before the draft starts):

- **Scoring format:** weekly head-to-head, or season points. A points league has no matchups or playoffs; standings rank teams by total points.
- **Regular season:** 8 to 16 weeks.
- **Playoffs:** 4 teams (semifinals and final), or none.
- **Waivers:** priority order, or FAAB (each team gets a budget to spend on sealed bids).
- **Trade deadline:** none, or through a chosen week.
- **Best ball:** the app sets every team's best projected lineup each week. Lineups can't be edited.
- **Pick timer:** 30 seconds to 10 minutes.

**Lineups and locks.** Lineup slots: QB, RB x2, WR x2, TE, WRT (any WR, RB or TE), K, DEF. Bench of 6, roster of 15. Players can only start in a slot they are eligible for, and the server enforces that. A player locks when his school's game kicks off, so he can't be moved or dropped after that. Lineup warnings on the Team tab point out empty slots and bench players who project higher than a starter.

**Draft.** Snake order. The commissioner sets the order or shuffles it. Each pick has a timer. Your draft queue is used first when your time runs out; otherwise the best available player by projected value is taken. Every CPU team's picks are made automatically by the same rule, and bots keep to position caps and minimums.

**Waivers and free agents.** Free agents can be added at once if there is roster space, or you can drop a player to make room. A waiver claim waits until the week closes. In priority order, the first team in line wins and moves to the back of the line. In FAAB leagues the highest bid wins, ties go to the better waiver position, and the winner pays from the budget.

**Trades.** One team proposes, and the other team accepts, declines or counters. A counter starts from the offer received, with the sides swapped, so the receiving coach can adjust it. The trade analyzer shows how the deal changes your team's value and projection before you send it. Each side can send up to 6 players, and rosters must stay within the limit.

**Roster changes from real life.** When a player transfers between Power Four schools, he stays on his fantasy team and the activity feed records the move. When a player leaves the Power Four, he is dropped from his fantasy team and the feed says so.

## Members, alerts and injury notes

**Joining and removing.** Before the draft, anyone with the invite code takes an open seat. During the draft nobody can join. After the draft, only a seat the commissioner has freed can be joined, and the new coach takes that team with its roster as it stands. The commissioner removes a member from Settings, in the Members card. The team goes to a CPU, its open trades and waiver claims close, and the removal appears in the activity feed. The commissioner cannot remove their own team, and a finished season cannot change its members.

**Alerts.** The league screen shows up to three alerts at the top, except on the tab where the fix happens. They cover: you are on the clock; a starter's game kicks off within the hour; a starter is listed Out, Doubtful or Injured reserve; a starting slot is empty; trade offers are waiting for an answer; and the trade deadline is this week. Alerts show when a coach opens the league. Push notifications are not built.

**Injury notes.** CollegeFootballData has no injury feed, so injury notes are entered by hand, and they show in every league:

```bash
npm run injury -- "Player Name" Out "hamstring"   # Questionable, Doubtful, Out or Injured reserve
npm run injury -- "Player Name" clear
```

A name that matches more than one player is refused. Use the player's id from the error message instead. Starters listed Doubtful, Out or Injured reserve get a warning on the Team tab. Questionable players show a tag but no warning.

**Help and support.** Settings, then Help, saves a message for whoever runs the app. A message is 10 to 1000 characters, and a coach can send five a day. Read the messages with `npm run feedback`. To show a support address on the sign-in page and the Help card, set `SUPPORT_EMAIL` in `.env`.

## Data and CFBD terms

- The app reads CFBD's `/teams/fbs`, `/roster`, `/games` and `/games/players` endpoints with your key.
- It stores derived per-player and per-team-game stat lines and team colors in your own database. It does not store or serve raw API responses, and it does not mirror CFBD's database.
- The app credits CollegeFootballData.com in its API (`GET /api/meta`).
- CFBD's terms allow commercial use, but do not allow redistributing raw data or databases. Logos, trademarks and player likenesses need separate clearance. This app uses colors and school names only, and it does not claim to be an official CFBD or NCAA product. Read the CFBD terms at https://collegefootballdata.com before you publish it.

To confirm the colors are real CFBD data: `GET /api/teams` returns the `color` and `alt_color` fields from the database. Teams with no color in CFBD show a neutral gray badge.

## Tests

```bash
npm test             # unit, rules and feature tests, a few seconds
npm run test:e2e     # browser tests at phone and laptop sizes, about three minutes
npm run load         # game-day load test: 80 coaches polling for 30 seconds
npm run test:all     # both
```

[TESTING.md](TESTING.md) has the full routine, including the phone and deploy checks.

The unit suite covers scoring, position mapping, ingest idempotence, waiver priority, and the API flow. The feature suite covers per-game locks, lineup warnings, FAAB, the trade deadline and counter-offers, the trade analyzer, the draft queue and order, points and head-to-head leagues, best ball, roster transfers and departures, recovery codes, sign-in limits, reactions, history, and backups. The fixes suite covers alerts, removing and joining members, the Help limits, the support address, injury notes from the command line, and an upgrade from an older database. The live suite covers score freshness and the refresh schedule.

## Limitations

- The live CFBD stat mapping has been written from CFBD's documented response shapes, but not run against a live key in this build. Run `npm run ingest:probe` on your key before the first real load.
- Playoffs use the postseason weeks as CFBD labels them. They are not a bracket that follows the real College Football Playoff.
- Single season only. Dynasty and keeper leagues, which carry players from one season to the next, are not built.
- No push notifications, no auction draft, and no native app store builds. The web app works on a phone home screen. Alerts show when a coach opens the league.
- Injury notes are entered by hand. The app cannot learn about injuries from CFBD.
- The laptop layout (a left rail and two-column Home from 900 px wide) was tested in Chromium. Check it in Edge on Windows too.
- Backups live on the same disk as the database unless you copy them off it (see *Backups and restore*).
