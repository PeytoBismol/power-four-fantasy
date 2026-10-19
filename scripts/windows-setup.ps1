# Power Four Fantasy: one-time setup and full test run for Windows PowerShell.
#
# Run from the project folder (the one with package.json):
#   powershell -ExecutionPolicy Bypass -File scripts\windows-setup.ps1
#
# Add -SkipE2E to skip the browser tests (they take about two minutes).

param([switch]$SkipE2E)

Set-Location -Path (Join-Path $PSScriptRoot '..')

function Step([string]$text) {
    Write-Host ''
    Write-Host "== $text" -ForegroundColor Cyan
}

Step 'Checking Node.js (needs 22.13 or newer)'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js is not installed. Install the LTS version from https://nodejs.org, open a new PowerShell window, and run this script again.'
}
$version = (& node -p 'process.versions.node').Trim()
$parts = $version.Split('.')
if (([int]$parts[0] -lt 22) -or (([int]$parts[0] -eq 22) -and ([int]$parts[1] -lt 13))) {
    throw "Node $version is too old. Install Node 22.13 or newer from https://nodejs.org."
}
Write-Host "Node $version found."

Step 'Creating .env from the example (only if it is missing)'
if (Test-Path '.env') {
    Write-Host '.env already exists, so it was left alone.'
} else {
    Copy-Item '.env.example' '.env'
    Write-Host 'Created .env. Your CFBD key goes there later (CFBD_API_KEY=...). The demo works without it.'
}

Step 'Installing packages'
& npm.cmd install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'npm install failed. Scroll up for the first error.' }

Step 'Installing the test browser (a large one-time download)'
& npx.cmd playwright install chromium
if ($LASTEXITCODE -ne 0) { throw 'Could not install the Chromium test browser. Check your internet connection and run this script again.' }

Step 'Running unit and API tests'
& npm.cmd test
if ($LASTEXITCODE -ne 0) { throw 'The unit and API tests failed. Scroll up to the first FAIL line.' }

if ($SkipE2E) {
    Write-Host ''
    Write-Host 'Skipped the browser tests (-SkipE2E).'
} else {
    Step 'Running browser tests at phone size (about two minutes)'
    & npm.cmd run test:e2e
    if ($LASTEXITCODE -ne 0) { throw 'The browser tests failed. Screenshots are in the test-results folder.' }
}

Write-Host ''
Write-Host 'All checks passed. To try the app: npm run ingest:demo, npm run demo, npm start, then open http://localhost:8080' -ForegroundColor Green
