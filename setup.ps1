# Atelier — one-shot setup for Windows (PowerShell). Idempotent: safe to re-run.
#
#   powershell -ExecutionPolicy Bypass -File setup.ps1
#
# The Windows counterpart of setup.sh: checks prereqs, installs deps, scaffolds
# config (.env.local + atelier.projects.json), generates the tool-bridge secret,
# and builds. Requires Windows PowerShell 5+ or PowerShell 7+.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Write-Bold($m) { Write-Host $m -ForegroundColor White }
function Write-Ok($m)   { Write-Host "  " -NoNewline; Write-Host ([char]0x2713) -ForegroundColor Green -NoNewline; Write-Host " $m" }
function Write-Warn($m) { Write-Host "  " -NoNewline; Write-Host "!" -ForegroundColor Yellow -NoNewline; Write-Host " $m" }
function Write-Fail($m) { Write-Host "  " -NoNewline; Write-Host ([char]0x2717) -ForegroundColor Red -NoNewline; Write-Host " $m" }
function Has($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

Write-Bold "Atelier setup (Windows)"

# 1) Node ----------------------------------------------------------------------
if (-not (Has "node")) {
  Write-Fail "node not found - install Node 20+ (https://nodejs.org) and re-run."; exit 1
}
$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) {
  Write-Fail "node $(node -v) is too old - need 20+."; exit 1
}
Write-Ok "node $(node -v)"

# 2) Required + optional CLIs ---------------------------------------------------
if (Has "git") { Write-Ok "git" } else { Write-Fail "git is required."; exit 1 }
if (Has "ollama") { Write-Ok "ollama" } else { Write-Warn "ollama not found - needed for cloud models (GLM/Qwen/Kimi) + the 'ollama launch claude' harness. Install from https://ollama.com." }
if (Has "claude") { Write-Ok "claude (Claude Code CLI)" } else { Write-Warn "claude CLI not found - needed only if you run Claude models. Install Claude Code." }
if (Has "gh")    { Write-Ok "gh (GitHub CLI)" } else { Write-Warn "gh not found - the agent uses it to open PRs. Install + 'gh auth login'." }
if (Has "ffmpeg") { Write-Ok "ffmpeg" } else { Write-Warn "ffmpeg not found - only used for QA video capture / demos." }

# Chrome: check the usual install paths, then the App Paths registry key.
$chromePaths = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$chromeFound = $chromePaths | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $chromeFound) {
  $reg = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"
  if (Test-Path $reg) { $chromeFound = (Get-ItemProperty $reg).'(default)' }
}
if ($chromeFound) { Write-Ok "Google Chrome" } else { Write-Warn "Google Chrome not found - needed for QA capture + Test-it. Set CHROME_PATH if it's elsewhere." }

# 3) Dependencies --------------------------------------------------------------
Write-Bold "Installing dependencies..."
npm install
if ($LASTEXITCODE -ne 0) { Write-Fail "npm install failed."; exit 1 }
Write-Ok "node_modules ready"

# 4) Config files --------------------------------------------------------------
if (-not (Test-Path ".env.local")) {
  Copy-Item ".env.example" ".env.local"
  Write-Warn "created .env.local - every value in it is OPTIONAL (the app runs without it)."
} else {
  Write-Ok ".env.local exists"
}
if (-not (Test-Path "atelier.projects.json")) {
  Copy-Item "atelier.projects.example.json" "atelier.projects.json"
  Write-Warn "created atelier.projects.json - point it at a git repo you want to build in (absolute repoPath + baseBranch)."
} else {
  Write-Ok "atelier.projects.json exists"
}

# Give the localhost tool bridge a unique secret instead of the predictable default.
# Matters if you ever expose the app (see ACCESS_PASSWORD in .env.example).
if ((Test-Path ".env.local") -and -not (Select-String -Path ".env.local" -Pattern '^FACTORY_INTERNAL_SECRET=' -Quiet)) {
  $secret = node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
  Add-Content -Path ".env.local" -Value "`n# Auto-generated secret for the internal tool bridge (/api/internal/tool).`nFACTORY_INTERNAL_SECRET=$secret"
  Write-Ok "generated FACTORY_INTERNAL_SECRET in .env.local"
}

# 5) Build ---------------------------------------------------------------------
Write-Bold "Building..."
npm run build
if ($LASTEXITCODE -ne 0) { Write-Fail "build failed."; exit 1 }
Write-Ok "built"

Write-Host @"

Done. Next:
  1. Log into the model CLI you'll use - claude (for Claude models) and/or
     ollama (for GLM/Qwen/Kimi). That's the model auth; there's no API key to set.
  2. Start it:   npm start      ->  http://localhost:7777
  3. In the UI: add a repo folder (or run in a scratch workspace) and start a loop.
     No need to hand-edit atelier.projects.json - the UI creates/registers folders.

(dev mode: npm run dev)
"@
