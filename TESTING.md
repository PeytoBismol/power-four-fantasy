# Testing Power Four Fantasy on Windows

Run every command in PowerShell from the project folder, the one that holds `package.json`.

## Once, on this PC

1. Install Node.js LTS from https://nodejs.org (version 22.13 or newer). Close and reopen PowerShell afterwards.
2. Run the setup script:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\windows-setup.ps1
   ```

It installs the packages and the test browser, then runs both test suites. It stops at the first failure and tells you where to look. The `-ExecutionPolicy Bypass` part only applies to that one run. If you later see "running scripts is disabled" when you type `npm`, run this once: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

## The routine

| When | Command | Takes | What it checks |
| --- | --- | --- | --- |
| After every change | `npm test` | seconds | Scoring, rules, and the API and feature flow: lineup locks, FAAB, trade deadline and counter-offers, the draft queue and order, points and best-ball leagues, transfers, recovery codes, sign-in limits, reactions, history, backups, live scores, alerts, removing and joining members, the Help limits, injury notes, and an upgrade from an older database |
| Before a deploy, or after touching the web app | `npm run test:e2e` | about 3 minutes | A real Chromium browser at phone size: every tab, moving players, chat and reactions, search, sign-up with a recovery code, forgot-password, dark mode, a points league with FAAB, a live 4-team draft with draft order and a queue, the trade analyzer, a counter-offer, the install prompt, and the offline shell. Then a laptop-width run: the left tab rail, two-column Home, removing a member, the on-the-clock alert, an injury alert and badge, the scores stamp, and the Help form |
| Both at once | `npm run test:all` | about 3 minutes | Everything above |
| Before game days, or after touching refresh or lineup code | `npm run load` | about 1 minute | 80 coaches polling like a game day: request times for each screen and any errors. See *Game day load test* below |
| After every deploy | smoke test (below) | 1 minute | The live server is up, its logs are clean, and the last backup is recent |
| Before you rely on it | phone check (below) | 15 minutes | The real install on a real phone |
| Before you rely on it | restore drill (below) | 10 minutes | A backup can be copied off the server and restored |

The browser tests start their own server and a throwaway database, so they never touch your real data. When something fails, the screenshots in `test-results\` show what the page looked like.

To watch the browser while the tests run, set `$env:PF_HEADED="1"` and then run `npm run test:e2e`. Clear it with `Remove-Item Env:PF_HEADED`. To use the Chrome already installed on this PC instead of the test browser, set `$env:PF_BROWSER="chrome"`.

## Phone check (before a release)

**Option A: same Wi-Fi.** Quick, but "Install" needs HTTPS, so this only tests the layout.

1. `npm run ingest:demo`, then `npm run demo`, then `npm start`.
2. Run `ipconfig` and note the IPv4 address (something like `192.168.1.20`).
3. On the phone, open `http://192.168.1.20:8080`. The first time, allow Node through Windows Firewall on private networks.

**Option B: a real install over HTTPS.** Use this to test "Add to Home Screen" properly.

1. Keep `npm start` running in one PowerShell window.
2. Install the tunnel once: `winget install --id Cloudflare.cloudflared`
3. In a second PowerShell window, run `cloudflared tunnel --url http://localhost:8080`
4. Open the `https://....trycloudflare.com` address it prints on your phone.
5. Add it to the home screen. iPhone: Safari, Share, Add to Home Screen. Android: Chrome, menu, Install app.

The tunnel address changes every time you start it, and anyone who has it can reach your PC's app while the tunnel runs. Use demo accounts only, and press Ctrl+C in both windows when you are done.

Checklist on the phone:

- [ ] Sign up with a new account. A recovery code appears. Copy it, then tap *I have saved it*.
- [ ] Sign out, choose *Forgot your password?*, and reset with that code. You are signed in again.
- [ ] Sign in with an account you made on the PC. Your league shows up.
- [ ] Switch Appearance to Dark on the leagues page. Every screen stays readable, then switch back to *Match phone*.
- [ ] Every tab fits the screen with no sideways scrolling.
- [ ] Open a player and move a bench player into a starting slot. The lineup stays full.
- [ ] Find a starter whose school's game is underway (or kicked off today). His sheet says *Locked*, and you can't move or drop him.
- [ ] Send a chat message, tap the **+** under it, pick an emoji, then see it on the PC.
- [ ] The home screen icon opens the app full screen.
- [ ] With airplane mode on, the app still opens its shell. League data needs a connection.
- [ ] On the PC, run `npm run injury -- "Player Name" Out "ankle"` for a starter on a phone-test team. Home shows an alert naming him, and his row has an *Out* tag. Then `npm run injury -- "Player Name" clear`.
- [ ] As commissioner, open Settings, tap *Remove* next to a member, and confirm. A box asks first. Afterwards that team shows as a CPU.
- [ ] Send a note from Settings, Help. On the PC, `npm run feedback` shows it.

**Laptop check (Edge on Windows).** Open the app at a laptop width. The league tabs are a column on the left, Home shows its cards in two columns, and nothing scrolls sideways. Narrow the window below about 900 pixels, and the tabs return to the bottom of the screen.

## After each deploy

```powershell
Invoke-RestMethod https://YOUR-APP.fly.dev/healthz
```

You should see `ok True`. Then check the live server:

```powershell
fly status
fly logs
```

`fly logs` streams live. Press Ctrl+C to stop. Use the live site for a minute while it streams and look for red error lines. Each scheduled ingest run logs a line `CFBD requests made: <number>`. If that line is missing for a long time, or a run reports an error, check the status:

```powershell
fly ssh console -C "node --disable-warning=ExperimentalWarning src/cli.js status"
```

The status output shows the last stats refresh, any last refresh error, and the last backup time. If the last backup is more than a day old, check `BACKUP_HOURS`.

**Stats refresh.** While the app runs on Fly, it refreshes stats every `INGEST_HOURS` hours (default 12 when `CFBD_API_KEY` is set). Each refresh re-reads rosters and box scores, so every run uses CFBD requests. Check the logged count against your plan's limit, and raise `INGEST_HOURS` if you are close. You can always refresh by hand:

```powershell
fly ssh console -C "node --disable-warning=ExperimentalWarning ingest/ingest.js"
```

## Game day

Before the first game of the week, check the server:

```powershell
fly ssh console -C "node --disable-warning=ExperimentalWarning src/cli.js status"
```

The output shows the refresh schedule (live scores every 10 minutes by default), the last ingest, and any last refresh error.

During games, open the Scores tab. The line under the title reads *N games in progress · scores updated* and a time. The time should move about every 10 minutes while games are on. If it says *may be behind* for more than 20 minutes, look at `fly logs` for red error lines, then run the status command above and read the refresh error, if one is shown.

Injuries are entered by hand, because CFBD has no injury feed. On the live server, `src/cli.js injury` takes the player's name or id, a status (Questionable, Doubtful, Out, Injured reserve, or `clear`), and an optional note. If a name matches more than one player, the command lists them with their ids, so run it again with the id.

To see how the server behaves under a game-day crowd before a big week, run the load test on the PC (see *Game day load test*).

## Game day load test

`npm run load` starts the real server on a throwaway database with demo data. It creates 80 coaches in 10 leagues and has each one poll the league, scores, team, chat, players and Home screens about every 8 seconds for 30 seconds. It prints the request count, the errors and the 50th, 95th and 99th percentile times for each screen. It fails if the 95th percentile goes above half a second or any request errors.

Options: `npm run load -- --users 240 --seconds 60 --interval 8`. The load generator runs on the same PC as the server, so treat the numbers as a floor. The real Fly machine will differ.

Results measured while building this version, on the PC:

| Coaches | Requests per second | Errors | 95th percentile | Worst |
| --- | --- | --- | --- | --- |
| 80 | 9 | 0 | 7.7 ms | 17.8 ms |
| 240, polling every 8 s | 26 | 0 | 7.6 ms | 24.4 ms |
| 240, polling every 2 s | 124 | 0 | 9.6 ms | 51.9 ms |

Each request runs in one short database transaction, and SQLite allows one write at a time. A second writer waits up to 5 seconds for the lock instead of failing. The load tests found no errors at any size, so no change to that design was needed. If a real game day ever shows slow screens, run `npm run load -- --users 240` again before and after a change, and compare the 95th percentile.

## Restore drill (before you rely on it)

Backups are only useful if you can restore one. Once, on this PC with demo data:

1. Stop `npm start` (Ctrl+C). Note the number of leagues you can see.
2. Run `npm run backup`. It prints the backup file name, in the `backups` folder next to the database.
3. Delete `data\power-four.sqlite`, and any `power-four.sqlite-wal` and `power-four.sqlite-shm` next to it.
4. Copy the backup file to `data\power-four.sqlite`.
5. Run `npm start` and sign in. Your leagues should be back.

On the live site, backups sit on the same volume as the database. Copy them off it regularly:

```powershell
fly ssh sftp get /app/data/backups/<backup-file>.sqlite .\backups\
```

Do this once to confirm the copy works, and keep the copies somewhere that is not Fly.

## Fixing common problems

| Symptom | Fix |
| --- | --- |
| `running scripts is disabled on this system` | Use `npm.cmd` in place of `npm`, or run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once |
| `EADDRINUSE` or "port 8080 is in use" | Run `netstat -ano \| findstr :8080`, then `taskkill /PID <number> /F`. Or use another port: `$env:PORT="8081"; npm start` |
| Phone can't open `http://192.168.x.x:8080` | Use the same Wi-Fi as the PC (not a guest network), let Node through Windows Firewall on private networks, and keep the PC awake |
| No Install option on the phone | Install needs HTTPS. Use the tunnel (Option B) or Fly |
| Old screen after a code change | Refresh the browser with Ctrl+F5. On the phone, remove the home screen icon and add it again |
| Forgot the password and the recovery code | On the PC, run `npm run reset-password -- you@example.com "a-new-password"`. It prints a new recovery code. Every session for that account is signed out |
| Status says the last stats refresh failed | Check `CFBD_API_KEY` is set on the server and the key has not expired. Run `npm run ingest:probe` to see the error from CFBD |
| Browser tests can't start Chromium | Run `npx.cmd playwright install chromium`, then run the tests again |
| The setup script fails while downloading | Check your connection or VPN. The script is safe to run again |
| Scores say *may be behind* during games | Check `CFBD_API_KEY` and `LIVE_SCORE_MINUTES` (it must be 5 or more, or `0` to turn it off), then run `npm run status` to read the last refresh error |
| `npm run injury` says more than one player matches | Run it again with the player's id from the message |
| The Help card shows no support address | Set `SUPPORT_EMAIL` in `.env` (a plain address, such as `support@example.com`), then restart the server |

## What the tests cannot tell you

- **Real stats and kickoff times.** The tests use built-in demo data. With your CFBD key in `.env`, run `npm run ingest:probe` to check the live feed, then `npm run ingest` to load it. Player locks depend on CFBD's kickoff times, so check one live week: a player's sheet should show the right kickoff.
- **Scheduled stats refresh on Fly.** The schedule runs inside the server and is covered by unit tests, but it has not run against the live CFBD service yet. Watch the first two refreshes in `fly logs`.
- **Safari on an iPhone.** The browser tests use Chromium at phone size. The phone checklist covers the real device.
- **Scoring against real games.** Before the first real week, compare a few players' points with their box scores by hand.
- **The Windows setup script.** It has not run on Windows yet.
- **Live scores with a real key.** The live refresh has been tested against the demo data and a fake CFBD source only. Run `npm run ingest:probe`, then watch the Scores tab during a real game window.
- **The laptop layout in Edge.** The browser tests use Chromium at 1366 by 800 pixels. Check it in Edge yourself, as the laptop check above describes.

## Status

The unit and feature tests (59 checks) and the browser tests (70 checks, including the laptop layout, the alerts, removing a member, injuries and the Help form) were run on Linux during the build, and all pass. The game-day load test passed at 80 and 240 coaches with no errors. An older database from before this version opens and upgrades with its teams intact. They have not run on Windows yet. Your first run of `scripts\windows-setup.ps1` is the real check. If it fails, send me the last 20 lines it printed.
