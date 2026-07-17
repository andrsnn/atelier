#!/usr/bin/env bash
# Atelier — one-shot setup. Idempotent: safe to re-run.
set -e
cd "$(dirname "$0")"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; }

bold "Atelier setup"

# 1) Node ----------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "  ✗ node not found — install Node 20+ (https://nodejs.org) and re-run."; exit 1
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "  ✗ node $(node -v) is too old — need 20+."; exit 1
fi
ok "node $(node -v)"

# 2) Required + optional CLIs ---------------------------------------------------
command -v git >/dev/null 2>&1 && ok "git" || { echo "  ✗ git is required."; exit 1; }
command -v ollama >/dev/null 2>&1 && ok "ollama" || warn "ollama not found — needed for cloud models (GLM/Qwen/Kimi) + the 'ollama launch claude' harness. Install from https://ollama.com."
command -v claude >/dev/null 2>&1 && ok "claude (Claude Code CLI)" || warn "claude CLI not found — needed only if you run Claude models. Install Claude Code."
command -v gh    >/dev/null 2>&1 && ok "gh (GitHub CLI)" || warn "gh not found — the agent uses it to open PRs. Install + 'gh auth login'."
command -v ffmpeg >/dev/null 2>&1 && ok "ffmpeg" || warn "ffmpeg not found — only used for QA video capture / demos."
[ -d "/Applications/Google Chrome.app" ] && ok "Google Chrome" || warn "Google Chrome not found — needed for QA capture + Test-it. Set CHROME_PATH if it's elsewhere."

# 3) Dependencies --------------------------------------------------------------
bold "Installing dependencies…"
npm install
ok "node_modules ready"

# 4) Config files --------------------------------------------------------------
if [ ! -f .env.local ]; then
  cp .env.example .env.local
  warn "created .env.local — every value in it is OPTIONAL (the app runs without it)."
else
  ok ".env.local exists"
fi
if [ ! -f atelier.projects.json ]; then
  cp atelier.projects.example.json atelier.projects.json
  warn "created atelier.projects.json — point it at a git repo you want to build in (absolute repoPath + baseBranch)."
else
  ok "atelier.projects.json exists"
fi

# Give the localhost tool bridge a unique secret instead of the predictable default.
# Matters if you ever expose the app (see ACCESS_PASSWORD in .env.example).
if [ -f .env.local ] && ! grep -q '^FACTORY_INTERNAL_SECRET=' .env.local 2>/dev/null; then
  SECRET=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
  printf '\n# Auto-generated secret for the internal tool bridge (/api/internal/tool).\nFACTORY_INTERNAL_SECRET=%s\n' "$SECRET" >> .env.local
  ok "generated FACTORY_INTERNAL_SECRET in .env.local"
fi

# 5) Build ---------------------------------------------------------------------
bold "Building…"
npm run build
ok "built"

cat <<'NEXT'

Done. Next:
  1. Log into the model CLI you'll use — `claude` (for Claude models) and/or
     `ollama` (for GLM/Qwen/Kimi). That's the model auth; there's no API key to set.
  2. Start it:   npm start      →  http://localhost:7777
  3. In the UI: add a repo folder (or run in a scratch workspace) and start a loop.
     No need to hand-edit atelier.projects.json — the UI creates/registers folders.

(dev mode: npm run dev)
NEXT
