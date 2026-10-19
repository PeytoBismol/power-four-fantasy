'use strict';

// End-to-end tests. Starts its own server on a free port with a throwaway database, seeds data
// through the real API, then drives Chromium at phone width. Nothing here touches your real data.
//
//   npm run test:e2e                         headless, about three minutes
//   PF_HEADED=1 npm run test:e2e             watch the browser
//   PF_BROWSER=chrome npm run test:e2e       use the Chrome installed on this PC instead of Playwright's Chromium

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { createApp } = require('../../src/server');
const { ingestAll } = require('../../ingest/ingest');
const { createDemoSource } = require('../../ingest/source-demo');

const SHOTS = path.join(__dirname, '..', '..', 'test-results');
const DEMO_EMAIL = 'demo@powerfour.local';
const DEMO_PASSWORD = 'demo-password-123';
const PASSWORD = 'password123';
// Recovery codes: four groups of four from an alphabet without I, O, 0 or 1
const CODE_RE = /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/;
// Expected noise: fonts are blocked on purpose, 401 is the wrong-password / signed-out response,
// and ERR_INTERNET_DISCONNECTED is the offline check
const EXPECTED_CONSOLE = [/ERR_FAILED/, /status of 401/, /ERR_INTERNET_DISCONNECTED/];

const results = [];
const problems = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`);
}

async function api(base, method, route, body, token) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${route} returned ${res.status} ${data.error || ''}`.trim());
  return data;
}

// Runs the draft through the API: CPU picks happen on the server, the human picks the best available
async function runDraft(base, leagueId, token) {
  await api(base, 'POST', `/api/leagues/${leagueId}/draft/start`, {}, token);
  for (let i = 0; i < 400; i++) {
    const { draft } = await api(base, 'GET', `/api/leagues/${leagueId}/draft`, undefined, token);
    if (draft.status === 'complete') return;
    if (draft.on_clock && draft.on_clock.is_me) {
      const { players } = await api(base, 'GET', `/api/leagues/${leagueId}/draft/available?pos=ALL`, undefined, token);
      await api(base, 'POST', `/api/leagues/${leagueId}/draft/pick`, { player_id: players[0].id }, token);
    }
  }
  throw new Error('the draft did not finish');
}

// A second human coach who picks by API while the commissioner picks in the browser
async function playRival(base, leagueId, token) {
  for (let i = 0; i < 400; i++) {
    const { draft } = await api(base, 'GET', `/api/leagues/${leagueId}/draft`, undefined, token);
    if (draft.status === 'complete') return;
    if (draft.on_clock && draft.on_clock.is_me) {
      const { players } = await api(base, 'GET', `/api/leagues/${leagueId}/draft/available?pos=ALL`, undefined, token);
      await api(base, 'POST', `/api/leagues/${leagueId}/draft/pick`, { player_id: players[0].id }, token);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('the rival draft did not finish');
}

function watch(page, label) {
  page.on('pageerror', (err) => problems.push(`${label}: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error' && msg.type() !== 'warning') return;
    if (EXPECTED_CONSOLE.some((re) => re.test(msg.text()))) return;
    problems.push(`${label}: ${msg.text()}`);
  });
  page.on('response', (res) => {
    if (res.status() >= 500) problems.push(`${label}: ${res.status()} ${res.url()}`);
  });
}

async function phoneContext(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: 'light'
  });
  // Google Fonts are blocked so the run works offline; the app falls back to system fonts
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  return context;
}

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const appText = (page) => page.evaluate(() => document.querySelector('#app')?.textContent || '');

// 1. A coach signs in, uses every screen, and recovers their account; a second coach signs up and joins
async function walkthrough(browser, base) {
  const context = await phoneContext(browser);
  const page = await context.newPage();
  watch(page, 'walkthrough');
  page.setDefaultTimeout(15000);

  await page.goto(`${base}/?t=${Date.now()}#/login`);
  await page.waitForSelector('form[data-form="auth"]');
  check('signed out visitors see sign in', page.url().endsWith('#/login'));
  check('sign in page fits phone width', (await overflow(page)) <= 0);
  check('sign in page offers a forgot password link', (await page.locator('[data-act="forgot"]').count()) === 1);
  await page.screenshot({ path: path.join(SHOTS, '01-login.png'), fullPage: true });

  await page.fill('input[name="email"]', DEMO_EMAIL);
  await page.fill('input[name="password"]', DEMO_PASSWORD);
  await page.click('form[data-form="auth"] button[type="submit"]');
  await page.waitForSelector('.league-row');
  check('sign in lands on leagues', true);

  // Appearance: dark mode applies at once and can be turned back to the phone's setting
  await page.click('[data-act="theme"][data-v="dark"]');
  const dark = await page.evaluate(() => ({
    attr: document.documentElement.getAttribute('data-theme'),
    bg: getComputedStyle(document.body).backgroundColor
  }));
  check('dark appearance applies to the app', dark.attr === 'dark' && dark.bg !== 'rgb(232, 234, 241)', dark.bg);
  await page.screenshot({ path: path.join(SHOTS, '01b-leagues-dark.png'), fullPage: true });
  await page.click('[data-act="theme"][data-v="light"]');
  check('light appearance can be chosen',(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'light');
  await page.click('[data-act="theme"][data-v="system"]');
  check('appearance can follow the phone again', (await page.evaluate(() => document.documentElement.hasAttribute('data-theme'))) === false);

  await page.click('.league-row:has-text("Demo League")');
  await page.waitForSelector('.hero');
  await page.waitForSelector('.standings');
  const hash = new URL(page.url()).hash;
  const leagueId = hash.split('/')[2];
  check('league opens on home', /\/home$/.test(hash), hash);
  check('home fits phone width', (await overflow(page)) <= 0);
  check('home shows power rankings for a finished league', (await appText(page)).includes('Power rankings'));
  await page.screenshot({ path: path.join(SHOTS, '02-home.png'), fullPage: true });

  await page.click(`.link-row[href="#/l/${leagueId}/draft"]`);
  await page.waitForFunction(() => document.querySelector('#app')?.textContent.includes('Draft complete'));
  check('home links to the draft room', true);

  const bottomTabs = ['team', 'players', 'scores', 'chat'];
  const otherTabs = ['draft', 'trades', 'settings'];
  for (const tab of [...bottomTabs, ...otherTabs]) {
    if (bottomTabs.includes(tab)) await page.click(`.nav a[href="#/l/${leagueId}/${tab}"]`);
    else await page.evaluate((h) => { location.hash = h; }, `#/l/${leagueId}/${tab}`);
    await page.waitForURL(new RegExp(`/${tab}$`));
    await page.waitForFunction(() => !document.querySelector('#app')?.textContent.includes('Loading…'));
    await page.waitForTimeout(300);
    const width = await overflow(page);
    check(`${tab} tab renders and fits the phone`, width <= 0, width > 0 ? `overflows by ${width}px` : '');
    await page.screenshot({ path: path.join(SHOTS, `03-${tab}.png`), fullPage: true });
  }

  await page.evaluate(() => { location.hash = '#/history'; });
  await page.waitForSelector('h1:has-text("Past seasons")');
  check('past seasons page opens', true);
  await page.evaluate((h) => { location.hash = h; }, `#/l/${leagueId}/team`);
  await page.waitForSelector('.nav');

  // Player sheet opens and closes
  await page.click(`.nav a[href="#/l/${leagueId}/team"]`);
  await page.waitForSelector('.list .prow[data-act="open"]');
  await page.click('.list .prow[data-act="open"] >> nth=0');
  await page.waitForSelector('.sheet');
  check('player sheet opens', true);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.sheet', { state: 'detached' }).catch(() => {});
  check('Escape closes the player sheet', (await page.locator('.sheet').count()) === 0);

  // Move a bench player into a starting slot; the starter count must not change
  const startersShown = () => page.evaluate(() => [...document.querySelectorAll('.lslot')].filter((e) => e.textContent.trim() !== 'BN').length);
  await page.click(`.nav a[href="#/l/${leagueId}/team"]`);
  await page.waitForSelector('.list');
  const startersBefore = await startersShown();
  const benchRows = page.locator('.prow[data-act="open"]').filter({ hasText: 'BN' });
  let moved = null;
  for (let i = 0; i < (await benchRows.count()) && !moved; i++) {
    await benchRows.nth(i).click();
    await page.waitForSelector('.sheet');
    const startButton = page.locator('.sheet button[data-act="move"]').filter({ hasText: 'Start at' }).first();
    if (await startButton.count()) {
      moved = await startButton.textContent();
      await startButton.click();
      await page.waitForFunction(() => document.querySelector('#toast')?.classList.contains('show'), null, { timeout: 4000 }).catch(() => {});
      const toastText = await page.textContent('#toast');
      check('moving a bench player confirms with a message', /starts at/.test(toastText), toastText);
      await page.waitForTimeout(600);
    } else {
      await page.keyboard.press('Escape');
      await page.waitForSelector('.sheet', { state: 'detached' }).catch(() => {});
    }
  }
  if (moved) check('moving a bench player keeps the lineup full', (await startersShown()) === startersBefore);
  else check('a bench player can move into a starting slot', false, 'no bench player had an open eligible slot');

  // Chat, then a reaction on the new message and a second tap to take it back
  await page.click(`.nav a[href="#/l/${leagueId}/chat"]`);
  await page.waitForSelector('form[data-form="chat"]');
  const text = `Hook em ${Date.now() % 1000}`;
  await page.fill('form[data-form="chat"] input[name="body"]', text);
  await page.click('form[data-form="chat"] button[type="submit"]');
  await page.waitForSelector(`#chat-log .msg-body:has-text("${text}")`, { timeout: 5000 });
  check('chat message appears in the log', true);
  await page.click('#chat-log .msg:last-child [data-act="react-open"]');
  await page.click('#chat-log .msg:last-child .picker .react >> nth=0');
  await page.waitForSelector('#chat-log .msg:last-child .react.on', { timeout: 5000 });
  check('a reaction can be added to a message', true);
  await page.click('#chat-log .msg:last-child .react.on');
  await page.waitForFunction(() => !document.querySelector('#chat-log .msg:last-child .react.on'), null, { timeout: 5000 }).catch(() => {});
  check('tapping a reaction again takes it back', (await page.locator('#chat-log .msg:last-child .react.on').count()) === 0);

  // Players search narrows the list
  await page.click(`.nav a[href="#/l/${leagueId}/players"]`);
  await page.waitForSelector('#player-list .prow');
  const before = await page.locator('#player-list .prow').count();
  await page.fill('input[data-input="q"]', 'zzzz-no-match');
  await page.waitForTimeout(700);
  const after = await page.locator('#player-list .prow').count();
  check('player search narrows the list', before > 0 && after === 0, `${before} then ${after}`);
  await page.fill('input[data-input="q"]', '');
  await page.waitForTimeout(600);

  // Create a points league with FAAB waivers from the phone
  await page.goto(`${base}/?t=${Date.now()}#/new`);
  await page.waitForSelector('form[data-form="new-league"]');
  await page.fill('form[data-form="new-league"] input[name="name"]', 'Browser Test League');
  await page.selectOption('form[data-form="new-league"] select[name="format"]', 'points');
  await page.selectOption('form[data-form="new-league"] select[name="waiver_mode"]', 'faab');
  await page.click('form[data-form="new-league"] button[type="submit"]');
  await page.waitForURL(/#\/l\/\d+\/home/);
  await page.waitForSelector('.hero');
  check('new league opens on draft night', /Draft night/.test(await page.textContent('.hero')));
  const code = (await page.textContent('.invite-code')).trim();

  await page.goto(`${base}/?t=${Date.now()}#/l/${new URL(page.url()).hash.split('/')[2]}/settings`);
  await page.waitForSelector('form[data-form="league-settings"]');
  check('the commissioner sees the rules form before the draft', true);

  // A second coach signs up, is shown a recovery code, and joins with the invite code
  await context.clearCookies();
  await page.goto(`${base}/?t=${Date.now()}#/signup`);
  await page.waitForSelector('form[data-form="auth"][data-mode="signup"]');
  const stamp = Date.now();
  await page.fill('input[name="name"]', 'Second Coach');
  await page.fill('input[name="email"]', `coach${stamp}@test.local`);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('form[data-form="auth"] button[type="submit"]');
  await page.waitForURL(/#\/recovery/);
  await page.waitForSelector('.invite-code');
  const recoveryCode = (await page.textContent('.invite-code')).trim();
  check('sign-up shows a recovery code once', CODE_RE.test(recoveryCode), recoveryCode);
  await page.click('a:has-text("I have saved it")');
  await page.waitForURL(/#\/leagues/);
  await page.goto(`${base}/?t=${Date.now()}#/join`);
  await page.waitForSelector('form[data-form="join"]');
  await page.fill('input[name="code"]', code);
  await page.click('form[data-form="join"] button[type="submit"]');
  await page.waitForURL(/#\/l\/\d+\/home/);
  await page.waitForSelector('.hero');
  check('second coach joins with the invite code', true, code);
  await page.click('.link-row[href$="/settings"]');
  await page.waitForSelector('.page-head h1:has-text("Settings")');
  const rules = await page.textContent('main');
  check('league rules show points scoring and FAAB waivers', /Season points/.test(rules) && /FAAB/.test(rules));

  // Forgot password: a wrong code is refused, the right code signs in and issues a new one
  await context.clearCookies();
  await page.goto(`${base}/?t=${Date.now()}#/login`);
  await page.waitForSelector('form[data-form="auth"]');
  await page.click('[data-act="forgot"]');
  await page.waitForSelector('form[data-form="reset"]');
  check('forgot password opens a reset form', true);
  await page.fill('form[data-form="reset"] input[name="email"]', `coach${stamp}@test.local`);
  await page.fill('form[data-form="reset"] input[name="recovery_code"]', 'ABCD-EFGH-JKMN-PQRS');
  await page.fill('form[data-form="reset"] input[name="password"]', 'brand-new-pass-9');
  await page.click('form[data-form="reset"] button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('.form-error')?.textContent.includes('do not match'), null, { timeout: 5000 }).catch(() => {});
  check('a wrong recovery code is refused', (await page.textContent('.form-error')).includes('do not match'));
  await page.fill('form[data-form="reset"] input[name="recovery_code"]', recoveryCode.toLowerCase());
  await page.click('form[data-form="reset"] button[type="submit"]');
  await page.waitForURL(/#\/recovery/);
  await page.waitForSelector('.invite-code');
  const replaced = (await page.textContent('.invite-code')).trim();
  check('a reset signs the coach in and issues a new code', replaced !== recoveryCode && CODE_RE.test(replaced));
  await page.click('a:has-text("I have saved it")');
  await page.waitForURL(/#\/leagues/);
  await page.goto(`${base}/?t=${Date.now()}#/recovery`);
  await page.waitForURL(/#\/leagues/);
  check('the recovery code is not shown again after a reload', (await page.locator('.invite-code').count()) === 0);

  // A wrong password shows an error on the form
  await context.clearCookies();
  await page.goto(`${base}/?t=${Date.now()}#/login`);
  await page.waitForSelector('form[data-form="auth"]');
  await page.fill('input[name="email"]', DEMO_EMAIL);
  await page.fill('input[name="password"]', 'wrong-password-here');
  await page.click('form[data-form="auth"] button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('.form-error')?.textContent.includes('incorrect'), null, { timeout: 5000 }).catch(() => {});
  check('wrong password shows an error', (await page.textContent('.form-error')).includes('incorrect'));

  await context.close();
}

// 2. A commissioner orders and starts a 4-team draft in the browser while a rival coach drafts by API,
//    then they trade: the commissioner tries the analyzer and counters an offer from the rival
async function liveDraft(browser, base) {
  const stamp = Date.now();
  const commissioner = await api(base, 'POST', '/api/auth/signup', { name: 'Draft Commish', email: `draft${stamp}@test.local`, password: PASSWORD });
  const token = commissioner.token;
  const { league } = await api(base, 'POST', '/api/leagues', { name: 'Live Draft Check', team_count: 4, pick_seconds: 60, regular_weeks: 8, playoff_teams: 0 }, token);
  const rival = await api(base, 'POST', '/api/auth/signup', { name: 'Rival Coach', email: `rival${stamp}@test.local`, password: PASSWORD });
  await api(base, 'POST', '/api/leagues/join', { code: league.invite_code }, rival.token);

  const context = await phoneContext(browser);
  await context.addCookies([{ name: 'pf_session', value: token, url: base }]);
  const page = await context.newPage();
  watch(page, 'draft');
  page.setDefaultTimeout(15000);

  // Draft order: the commissioner moves the first team down one place
  await page.goto(`${base}/?t=${stamp}#/l/${league.id}/draft`);
  await page.waitForSelector('[data-act="order-move"]');
  const orderBefore = await page.locator('.prow.static .pname').allTextContents();
  await page.click('[data-act="order-move"][data-dir="1"] >> nth=0');
  await page.waitForTimeout(700);
  const orderAfter = await page.locator('.prow.static .pname').allTextContents();
  check('the commissioner can change the draft order', orderAfter[0] === orderBefore[1] && orderAfter[1] === orderBefore[0], orderAfter.join(', '));

  await page.click('[data-act="start-draft"]');
  await page.waitForSelector('#draft-avail .prow');
  check('draft room opens after starting', true);

  // Queue two players, move the second up, then take one back out
  await page.click('#draft-avail [data-act="queue-add"]:not([disabled]) >> nth=0');
  await page.waitForSelector('#queue-panel .prow');
  await page.click('#draft-avail [data-act="queue-add"]:not([disabled]) >> nth=0');
  await page.waitForFunction(() => document.querySelectorAll('#queue-panel .prow').length === 2, null, { timeout: 5000 }).catch(() => {});
  check('two players can be queued', (await page.locator('#queue-panel .prow').count()) === 2);
  const queueBefore = await page.locator('#queue-panel .pname').allTextContents();
  await page.click('#queue-panel [data-act="queue-move"][data-dir="-1"] >> nth=1');
  await page.waitForTimeout(500);
  const queueAfter = await page.locator('#queue-panel .pname').allTextContents();
  check('the queue can be reordered', queueAfter[0] === queueBefore[1] && queueAfter[1] === queueBefore[0]);
  await page.click('#queue-panel [data-act="queue-remove"] >> nth=0');
  await page.waitForFunction(() => document.querySelectorAll('#queue-panel .prow').length === 1, null, { timeout: 5000 }).catch(() => {});
  check('a queued player can be removed', (await page.locator('#queue-panel .prow').count()) === 1);

  let rivalError = null;
  const rivalTurns = playRival(base, league.id, rival.token).catch((err) => { rivalError = err; });

  let myPicks = 0;
  let sawTimer = false;
  for (let i = 0; i < 400; i++) {
    if ((await appText(page)).includes('Draft complete')) break;
    const pick = page.locator('#draft-avail button[data-act="draft-pick"]:not([disabled])').first();
    if (await pick.count()) {
      if (!sawTimer) sawTimer = (await page.locator('.timer').count()) > 0;
      await pick.click();
      myPicks++;
      await page.waitForTimeout(300);
    } else {
      await page.waitForTimeout(1000);
    }
  }
  await rivalTurns;
  check('the rival coach makes every pick', !rivalError, rivalError ? rivalError.message : '');
  check('the commissioner makes 15 picks', myPicks === 15, `${myPicks} picks`);
  check('the pick timer is shown while on the clock', sawTimer);
  check('the draft completes on screen', (await appText(page)).includes('Draft complete'));

  await page.goto(`${base}/?t=${stamp}b#/l/${league.id}/team`);
  await page.waitForSelector('.stats3');
  const roster = (await page.textContent('.stats3')).replace(/\s+/g, ' ');
  check('roster is full after the draft', /15\s*\/\s*15/.test(roster), roster.trim());
  await page.screenshot({ path: path.join(SHOTS, '04-draft-team.png'), fullPage: true });

  // Trade analyzer: pick a partner and one player on each side
  await page.goto(`${base}/?t=${stamp}d#/l/${league.id}/trades`);
  await page.waitForSelector('.trade-builder');
  await page.click('.trade-builder [data-act="trade-to"] >> nth=0');
  await page.waitForSelector('.trade-builder [data-act="trade-toggle"][data-side="get"]');
  await page.click('.trade-builder [data-act="trade-toggle"][data-side="give"] >> nth=0');
  await page.click('.trade-builder [data-act="trade-toggle"][data-side="get"] >> nth=0');
  await page.waitForSelector('.analyzer .display', { timeout: 8000 });
  const verdict = (await page.textContent('.analyzer .display')).trim();
  check('the trade analyzer gives a verdict', /favors you|favors them|About even/.test(verdict), verdict);

  // The rival offers a trade; the commissioner counters it from the offer's own players
  const view = await api(base, 'GET', `/api/leagues/${league.id}`, undefined, rival.token);
  const commTeam = view.teams.find((t) => t.owner === 'Draft Commish').id;
  const rivalRoster = (await api(base, 'GET', `/api/leagues/${league.id}/teams/${view.my_team_id}`, undefined, rival.token)).roster;
  const commRoster = (await api(base, 'GET', `/api/leagues/${league.id}/teams/${commTeam}`, undefined, rival.token)).roster;
  await api(base, 'POST', `/api/leagues/${league.id}/trades`, {
    to_team_id: commTeam,
    give: [rivalRoster[0].player.id],
    get: [commRoster[0].player.id]
  }, rival.token);

  await page.reload();
  await page.waitForSelector('[data-act="trade-counter"]');
  check('an incoming offer shows a Counter button', true);
  await page.click('[data-act="trade-counter"]');
  await page.waitForSelector('.trade-builder h2:has-text("Counter-offer")');
  const preloaded = await page.locator('.trade-builder .prow.sel').count();
  check('a counter starts from the offer received', preloaded === 2, `${preloaded} players selected`);
  await page.click('[data-act="trade-propose"]');
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Counter-offer sent'), null, { timeout: 5000 }).catch(() => {});
  check('the counter-offer is sent', (await page.textContent('#toast')).includes('Counter-offer sent'));
  await page.waitForFunction(() => document.querySelector('#app')?.textContent.includes('countered'), null, { timeout: 5000 }).catch(() => {});
  check('the original offer is marked as countered', (await appText(page)).includes('countered'));
  await context.close();
}

// 3. Installable as a home screen app, and the app shell opens with no connection
async function installCheck(browser, base) {
  const context = await phoneContext(browser);
  const page = await context.newPage();
  watch(page, 'install');
  page.setDefaultTimeout(15000);
  await page.goto(`${base}/?t=${Date.now()}#/login`);
  await page.waitForSelector('form[data-form="auth"]');

  const manifest = await page.evaluate(async () => {
    const res = await fetch('/manifest.webmanifest');
    return { status: res.status, json: await res.json() };
  });
  check('web app manifest is served', manifest.status === 200 && manifest.json.name === 'Power Four Fantasy');
  const iconUrls = manifest.json.icons.map((i) => i.src).concat(['/icons/apple-touch-icon.png']);
  const iconStatus = await page.evaluate(async (urls) => Promise.all(urls.map(async (u) => {
    const res = await fetch(u);
    return res.status === 200 && res.headers.get('content-type') === 'image/png';
  })), iconUrls);
  check('every home screen icon loads as a PNG', iconStatus.every(Boolean));

  const cdp = await context.newCDPSession(page);
  await cdp.send('Page.enable');
  const install = await cdp.send('Page.getInstallabilityErrors').catch((err) => ({ installabilityErrors: [err.message] }));
  check('Chromium reports the app as installable', (install.installabilityErrors || []).length === 0, (install.installabilityErrors || []).join(' | '));

  const swActive = await page.evaluate(() => navigator.serviceWorker.ready.then((r) => !!r.active).catch(() => false));
  check('service worker is active', swActive);

  await page.waitForTimeout(800);
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#app')?.textContent.trim().length > 20, null, { timeout: 10000 }).catch(() => {});
  check('app shell opens with no connection', (await appText(page)).trim().length > 20);
  await context.setOffline(false);
  await context.close();
}

// 4. The Sleeper fixes: a laptop layout, a commissioner removing a coach before the draft, the on-the-clock alert,
// an injury, the scores stamp, the Help form, and the alerts on a phone
async function fixesCheck(browser, base, app, token) {
  const { league } = await api(base, 'POST', '/api/leagues', { name: 'Fixes League', team_count: 4, pick_seconds: 60, regular_weeks: 8, playoff_teams: 0 }, token);
  const code = app.db.prepare('SELECT invite_code FROM leagues WHERE id = ?').get(league.id).invite_code;
  const leaver = await api(base, 'POST', '/api/auth/signup', { name: 'Leaving Coach', email: 'leaving@powerfour.local', password: PASSWORD });
  await api(base, 'POST', '/api/leagues/join', { code }, leaver.token);

  const laptop = await browser.newContext({ viewport: { width: 1366, height: 800 }, colorScheme: 'light' });
  await laptop.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  const page = await laptop.newPage();
  watch(page, 'laptop');
  page.setDefaultTimeout(15000);
  await page.goto(`${base}/?t=${Date.now()}#/login`);
  await page.waitForSelector('form[data-form="auth"]');
  await page.fill('input[name="email"]', DEMO_EMAIL);
  await page.fill('input[name="password"]', DEMO_PASSWORD);
  await page.click('form[data-form="auth"] button[type="submit"]');
  await page.waitForSelector('.league-row');

  // Laptop: the league tabs form a left rail, Home uses two columns, and nothing scrolls sideways
  await page.goto(`${base}/?t=${Date.now()}#/l/${league.id}/home`);
  await page.waitForSelector('.nav');
  const rail = await page.evaluate(() => {
    const r = document.querySelector('.nav').getBoundingClientRect();
    return { left: r.left, width: r.width, height: r.height };
  });
  check('on a laptop the league tabs form a left rail', rail.left < 4 && rail.width < 260 && rail.height > rail.width, JSON.stringify(rail));
  const columns = await page.evaluate(() => {
    const grid = document.querySelector('.home-grid');
    return grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0;
  });
  check('on a laptop Home puts its cards in two columns', columns === 2, `${columns} columns`);
  check('laptop screens do not scroll sideways', (await overflow(page)) <= 0);

  // Commissioner removes a coach before the draft: the seat becomes a CPU
  await page.goto(`${base}/?t=${Date.now()}#/l/${league.id}/settings`);
  await page.waitForSelector('.members');
  check('the commissioner sees each member in Settings', (await page.locator('.members [data-act="release-member"]').count()) === 1);
  page.once('dialog', (dialog) => dialog.accept());
  await page.click('.members [data-act="release-member"]');
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('was removed'));
  check('removing a member hands the seat to a CPU', (await page.locator('.members [data-act="release-member"]').count()) === 0);

  // The commissioner picks first, so the alert names the on-the-clock pick on Home but not on the draft tab
  const teams = app.db.prepare('SELECT id, user_id FROM fantasy_teams WHERE league_id = ? ORDER BY id').all(league.id);
  const mine = teams.find((t) => t.user_id !== null);
  [mine, ...teams.filter((t) => t.id !== mine.id)].forEach((t, i) => {
    app.db.prepare('UPDATE fantasy_teams SET draft_slot = ? WHERE id = ?').run(i + 1, t.id);
  });
  await api(base, 'POST', `/api/leagues/${league.id}/draft/start`, {}, token);
  await page.goto(`${base}/?t=${Date.now()}#/l/${league.id}/home`);
  await page.waitForSelector('.alert.now', { timeout: 10000 });
  check('the coach on the clock sees an alert on Home', (await page.textContent('.alert.now')).includes('on the clock'));
  await page.goto(`${base}/?t=${Date.now()}#/l/${league.id}/draft`);
  await page.waitForFunction(() => location.hash.endsWith('/draft'));
  await page.waitForTimeout(500);
  check('the on-the-clock alert is hidden on the draft tab itself', (await page.locator('.alert.now').count()) === 0);
  await playRival(base, league.id, token);

  // In season: a starter is listed Out. Home names him, and the roster shows a badge.
  const starter = app.db.prepare(`
    SELECT r.player_id AS id, p.name FROM roster r JOIN players p ON p.id = r.player_id
    WHERE r.team_id = ? AND r.slot != 'BN' ORDER BY r.slot LIMIT 1
  `).get(mine.id);
  app.db.prepare("INSERT INTO player_status (player_id, status, note, updated_at) VALUES (?, 'Out', 'ankle', ?)")
    .run(starter.id, new Date().toISOString());
  await page.goto(`${base}/?t=${Date.now()}#/l/${league.id}/home`);
  await page.waitForSelector('.alert.warn', { timeout: 10000 });
  const warnings = await page.textContent('.alerts');
  check('an injured starter is named on Home', warnings.includes(starter.name) && warnings.includes('listed Out'), warnings.trim().slice(0, 120));
  await page.goto(`${base}/?t=${Date.now()}#/l/${league.id}/team`);
  await page.waitForSelector('.inj-o', { timeout: 10000 });
  check('the roster shows the injury as a badge', (await page.locator('.inj-o').count()) >= 1);

  await page.goto(`${base}/?t=${Date.now()}#/l/${league.id}/scores`);
  await page.waitForSelector('.stamp', { timeout: 10000 });
  const stamp = await page.textContent('.stamp');
  check('the scores tab says when scores were last updated', /Scores updated/.test(stamp), stamp.trim());

  await page.goto(`${base}/?t=${Date.now()}#/l/${league.id}/settings`);
  await page.waitForSelector('form[data-form="feedback"]');
  await page.fill('form[data-form="feedback"] textarea[name="body"]', 'The scores tab should say when it last refreshed.');
  await page.click('form[data-form="feedback"] button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Thanks'));
  const saved = app.db.prepare('SELECT COUNT(*) AS n FROM feedback WHERE league_id = ?').get(league.id).n;
  check('a Help message reaches the server', saved === 1, `${saved} saved`);

  // Phone width: the same screens fit with no sideways scroll
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/?t=${Date.now()}#/l/${league.id}/home`);
  await page.waitForSelector('.alert.warn', { timeout: 10000 });
  check('the alerts fit a phone screen', (await overflow(page)) <= 0);
  await laptop.close();
}

function removeDir(dir) {
  // Windows can hold the database file for a moment after the server closes, so retry briefly
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch (err) { /* retry */ }
  }
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-e2e-'));
  const app = createApp({ dbFile: path.join(dir, 'e2e.sqlite') });
  let browser = null;
  try {
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    await ingestAll({ db: app.db, source: createDemoSource({ year: 2026 }), log: () => {} });

    // Seed the demo coach and a finished 4-team league through the real API
    const demo = await api(base, 'POST', '/api/auth/signup', { name: 'Demo Coach', email: DEMO_EMAIL, password: DEMO_PASSWORD });
    const token = demo.token;
    const { league } = await api(base, 'POST', '/api/leagues', { name: 'Demo League', team_count: 4, pick_seconds: 60, regular_weeks: 8, playoff_teams: 0 }, token);
    await runDraft(base, league.id, token);
    check('seeded a finished demo league through the API', true);

    try {
      browser = await chromium.launch({
        headless: !process.env.PF_HEADED,
        channel: process.env.PF_BROWSER === 'chrome' ? 'chrome' : undefined
      });
    } catch (err) {
      throw new Error(`could not start the browser (${err.message.split('\n')[0]}). Run: npx playwright install chromium`);
    }
    await walkthrough(browser, base);
    await liveDraft(browser, base);
    await fixesCheck(browser, base, app, token);
    await installCheck(browser, base);
  } catch (err) {
    check('the test run finished', false, err.message);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => app.server.close(resolve));
    removeDir(dir);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
  if (problems.length) {
    console.log(`Browser problems (${problems.length}):`);
    for (const p of problems.slice(0, 20)) console.log('  ' + p);
  } else {
    console.log('No browser console errors or server errors.');
  }
  console.log(`Screenshots: ${SHOTS}`);
  process.exitCode = failed.length || problems.length ? 1 : 0;
})();
