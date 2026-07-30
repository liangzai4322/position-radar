$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "FAIL: $Message" }
  Write-Host "PASS: $Message"
}

$required = @(
  'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'sw.js', 'offline.html', 'favicon.ico', 'status.sample.json',
  'assets/icons/icon-192.png', 'assets/icons/icon-512.png'
)
foreach ($file in $required) { Assert-True (Test-Path (Join-Path $Root $file)) "asset exists: $file" }

$sample = Get-Content -Raw (Join-Path $Root 'status.sample.json') | ConvertFrom-Json
Assert-True ($null -ne $sample.items) 'API sample contains items'
Assert-True ($sample.items.Count -eq $sample.count) 'API count matches item count'
Assert-True ($null -ne $sample.market_game) 'API sample contains market_game'
Assert-True ($null -ne $sample.recent_liq_panel) 'API sample contains recent_liq_panel'
foreach ($item in $sample.items) { Assert-True ($null -ne $item.positions) "account $($item.uniqueName) contains positions" }

$manifest = [IO.File]::ReadAllText((Join-Path $Root 'manifest.webmanifest'), [Text.Encoding]::UTF8) | ConvertFrom-Json
Assert-True ($manifest.start_url -eq './') 'manifest uses relative start_url'
Assert-True ($manifest.icons.Count -ge 2) 'manifest contains PWA icons'

$index = Get-Content -Raw (Join-Path $Root 'index.html')
Assert-True ($index -match 'content-security-policy') 'page configures CSP'
Assert-True ($index -match 'aria-live') 'page includes accessible live regions'
Assert-True ($index -notmatch '<script[^>]*>\s*[^<]') 'page has no inline script'
Assert-True ($index -match 'id="rank-type"') 'page includes leaderboard category selector'

$app = Get-Content -Raw (Join-Path $Root 'app.js')
Assert-True ($app -match 'AbortController') 'poller uses AbortController'
Assert-True ($app -match 'visibilitychange') 'poller responds to visibility changes'
Assert-True ($app -match "searchParams\.set\('rank_type'") 'status request includes selected leaderboard category'
Assert-True ($app -notmatch '/api/settings|switch-rank|method:\s*["'']POST') 'public app contains no mutation endpoint'

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  & $node.Source --check (Join-Path $Root 'app.js')
  if ($LASTEXITCODE -ne 0) { throw 'FAIL: app.js syntax check' }
  Write-Host 'PASS: app.js syntax check'
}

Write-Host "`nAll frontend smoke checks passed."
