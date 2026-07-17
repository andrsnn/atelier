#!/usr/bin/env node
// Build, start the production server, and expose it PRIVATELY on the tailnet.
//
// Uses `tailscale serve` (tailnet-only HTTPS proxy) — NOT `tailscale funnel`,
// so the URL is only reachable by devices signed into your own Tailscale account.
//
//   npm run tailnet            build + start + serve
//   npm run tailnet -- --no-build   skip `next build`, just start + serve
//
// Ctrl-C tears down the tailscale serve mapping and stops the server.

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';

const PORT = 7777;
const SKIP_BUILD = process.argv.includes('--no-build');

const sh = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { stdio: 'inherit', encoding: 'utf8', ...opts });

const ts = (args, opts = {}) =>
  spawnSync('tailscale', args, { encoding: 'utf8', ...opts });

function log(msg) {
  process.stdout.write(`\x1b[36m› ${msg}\x1b[0m\n`);
}
function die(msg) {
  process.stderr.write(`\x1b[31m✗ ${msg}\x1b[0m\n`);
  process.exit(1);
}

// 1. Build ------------------------------------------------------------------
if (!SKIP_BUILD) {
  log('Building (next build)…');
  const r = sh('npx', ['next', 'build']);
  if (r.status !== 0) die('build failed');
} else {
  log('Skipping build (--no-build)');
}

// 2. Bring Tailscale up ------------------------------------------------------
function backendState() {
  const r = ts(['status', '--json']);
  try {
    return JSON.parse(r.stdout).BackendState;
  } catch {
    return 'Unknown';
  }
}

if (backendState() !== 'Running') {
  log('Tailscale is stopped — bringing it up (tailscale up)…');
  const r = ts(['up'], { stdio: 'inherit' });
  if (r.status !== 0) {
    die('`tailscale up` failed. If it printed an auth URL, open it, then re-run this command.');
  }
  // give the backend a moment to settle
  for (let i = 0; i < 30 && backendState() !== 'Running'; i++) {
    spawnSync('sleep', ['1']);
  }
  if (backendState() !== 'Running') die('Tailscale did not reach Running state.');
}

const dnsName = (() => {
  const r = ts(['status', '--json']);
  const name = JSON.parse(r.stdout).Self?.DNSName || '';
  return name.replace(/\.$/, ''); // trim trailing dot
})();
if (!dnsName) die('Could not determine this machine’s MagicDNS name.');

// 3. Start the production server --------------------------------------------
log(`Starting production server on :${PORT}…`);
const server = spawn('npx', ['next', 'start', '--port', String(PORT)], {
  stdio: 'inherit',
  env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' },
});

// 4. Wait for it to answer ---------------------------------------------------
function waitForServer(retries = 60) {
  return new Promise((resolve, reject) => {
    const tick = (n) => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/', timeout: 1500 }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => (n <= 0 ? reject(new Error('server never came up')) : setTimeout(() => tick(n - 1), 1000)));
      req.on('timeout', () => { req.destroy(); n <= 0 ? reject(new Error('server timeout')) : setTimeout(() => tick(n - 1), 1000); });
    };
    tick(retries);
  });
}

// 5. Expose privately on the tailnet, print the URL -------------------------
const cleanup = () => {
  try { ts(['serve', 'reset']); } catch {}
  try { server.kill('SIGTERM'); } catch {}
};
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
server.on('exit', (code) => { try { ts(['serve', 'reset']); } catch {} process.exit(code ?? 0); });

try {
  await waitForServer();
} catch (e) {
  cleanup();
  die(`server did not become ready: ${e.message}`);
}

log('Publishing to the tailnet (tailscale serve, private)…');
const r = ts(['serve', '--bg', String(PORT)], { stdio: 'inherit' });
if (r.status !== 0) { cleanup(); die('`tailscale serve` failed.'); }

const url = `https://${dnsName}/`;
process.stdout.write(
  `\n\x1b[42m\x1b[30m PRIVATE URL \x1b[0m  \x1b[1m${url}\x1b[0m\n` +
  `\x1b[2m  reachable only by devices on your tailnet · Ctrl-C to stop & tear down\x1b[0m\n\n`,
);
