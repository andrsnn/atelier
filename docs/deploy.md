# Deploying Atelier for a team

One Atelier instance is one process: the web UI, the HTTP API, and the engine that
runs the agents — all in the Next.js server, with state in SQLite next to it. Deploying
for a team means running that process on a machine everyone can reach. Clients install
nothing: the browser loads the board from the server, and the `atelier` terminal UI is
a pure HTTP client (`atelier --url http://host:7777`).

## The shape

```
your laptop                          the shared host
───────────                          ─────────────────────────────────────────────
browser ─────────── HTTP ─────────▶  next server, port 7777
atelier TUI ─────── HTTP ─────────▶   ├─ web UI + REST API (poll-based)
                                      ├─ runner — spawns the agent per phase:
                                      │    claude / ollama launch claude
                                      │    (its stream-JSON is consumed in-process;
                                      │     events + artifacts land in SQLite)
                                      ├─ .factory/factory.db        (all state)
                                      ├─ .factory/workspaces/<run>  (git worktrees)
                                      └─ test-drive dev servers     (own ports)
```

The agent processes run **on the host**, as children of the server. Nothing streams
from your laptop; your comments and approvals are ordinary API writes, and every
viewer polls the same run out of the same database. The one HTTP hop inside the
factory is the agent's tool bridge (`bin/factool.mjs` → `/api/internal/tool`), which
targets the server's own address.

## Pick a host

Any always-on macOS or Linux box works: a spare Mac mini, an office server, a cloud
VM. It needs the repos, the credentials, and enough CPU for a dev server + a browser
during QA. Laptops work but sleep — a sleeping host is a paused factory.

## Set it up (once, on the host)

1. **Install the tools the factory shells out to:**
   Node 20+, `git`, Chrome or Chromium (any path — set `CHROME_PATH`), `ffmpeg`
   (QA video), [`gh`](https://cli.github.com), [`ollama`](https://ollama.com), and the
   Claude Code CLI if you'll run Claude models.
2. **Authenticate as the user the service will run as:**
   `gh auth login` (the agent opens PRs as this account — consider a bot/machine
   account so team PRs aren't attributed to one person), `ollama` signed in +
   `OLLAMA_API_KEY`, `claude` logged in.
3. **Clone the repos** the factory will build in, then register each in
   `atelier.projects.json` (absolute `repoPath`, `baseBranch`, optional
   `devCommand`/`auth` recipe).
4. **Configure `.env.local`:**

   ```bash
   OLLAMA_API_KEY=…
   ACCESS_PASSWORD=…            # the gate — required before exposing anything
   FACTORY_INTERNAL_SECRET=…    # setup.sh generates one; never leave default when shared
   CHROME_PATH=/usr/bin/chromium
   FACTORY_PUBLIC_HOST=atelier.tailnet.example.com   # name teammates can reach (test-drive URLs)
   FACTORY_MAX_CONCURRENT_RUNS=2                     # optional; default 1 (runs queue)
   ```

5. **Build and run:**

   ```bash
   ./setup.sh && npm run build
   npm start        # port 7777
   ```

   As a service (Linux):

   ```ini
   # /etc/systemd/system/atelier.service
   [Unit]
   Description=Atelier
   After=network.target

   [Service]
   User=atelier
   WorkingDirectory=/home/atelier/atelier
   ExecStart=/usr/bin/npm start
   Restart=on-failure

   [Install]
   WantedBy=multi-user.target
   ```

   On macOS, a `launchd` plist or just `npm start` in a `tmux` session does the same job.

## Reach it

The server listens on all interfaces, so pick by where the team is:

- **Same network** — nothing to do: `http://<host-ip>:7777`, unlock with the password.
- **Tailscale (or any VPN)** — the nicest fit. The board *and* the test-drive dev
  servers (which listen on their own ports) are both reachable; set
  `FACTORY_PUBLIC_HOST` to the tailnet name so shared URLs come out right. Nothing is
  exposed to the public internet.
- **A tunnel (`cloudflared`, `ngrok`)** — fine for the board itself
  (`cloudflared tunnel --url http://localhost:7777`). Know that a tunnel to 7777 does
  **not** carry test-drive dev servers — they're separate ports — so remote teammates
  get the board, comments, and the Conductor, but "Test it" URLs only work for people
  with network reach.

## Headless notes

A shared Linux host usually has no display. That's fine:

- QA capture, screenshots, walkthrough videos, and auth all run headless already.
- **Test-drive** skips opening a window on the host and hands back the shareable URL
  instead (this is where `FACTORY_PUBLIC_HOST` earns its keep). The login it restored
  and the credentials it surfaces work the same from your machine.

## Care and feeding

- **State is two directories:** `.factory/` (the DB) and the workspaces dir. Back
  them up; nothing else on the host is Atelier state.
- **Upgrades:** `git pull && npm install && npm run build`, restart the service —
  ideally between runs. The scheduler re-adopts anything mid-flight (`reconcile()`),
  but a phase interrupted by a restart re-drives from its last state.
- **Identity:** everyone sets a display name once (the web asks; the CLI takes
  `--user`). Names sign comments, drive presence, and are how the Conductor
  attributes feedback.
- **Reap** (gear menu, or `POST /api/reap`) closes stray test-drive browsers and dev
  servers if a session ends abruptly.

## The honest edges

Same as [the README's team section](../README.md#running-it-as-a-team): one password
is one permission tier; names are labels, not accounts; everything a teammate triggers
executes with the host's credentials; test-drive dev servers are visible to whoever
can reach the host's ports. Deploy inside a network boundary you trust (VPN/tailnet),
not on the open internet.
