#!/usr/bin/env node
// Beads Explorer: open the beads issues and memories of the repository you are in (or the one you name) in the browser.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../lib/server.mjs';

const HELP = `Beads Explorer: browse and edit a repository's beads issues and memories in the browser.

Usage: beads-explorer [repo-path] [options]

  repo-path        a folder inside the repository (default: the current folder);
                   the nearest folder above it that holds .beads is used
  --port <n>       port to listen on (default 4410, or the next free one)
  --owner <name>   show "Waiting on <name>": open issues titled "<name>: ..." or labelled <name>
  --no-open        do not open the browser
  -v, --version    print the version
  -h, --help       print this help

Environment: BEADS_EXPLORER_PORT, BEADS_EXPLORER_OWNER, BEADS_EXPLORER_NO_OPEN, BEADS_EXPLORER_BD (bd binary),
BEADS_EXPLORER_CLAUDE (claude binary), ANTHROPIC_API_KEY (use the API for the chat), BEADS_EXPLORER_MODEL,
BEADS_EXPLORER_MAX_USD (spending cap per chat turn, default 1).`;

export function parseArgs(argv) {
  const out = { path: null, port: null, owner: null, open: true, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
      if (v === undefined || v === '') throw new Error(`${a.split('=')[0]} needs a value`);
      return v;
    };
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '-v' || a === '--version') out.version = true;
    else if (a === '--no-open') out.open = false;
    else if (a === '--port' || a.startsWith('--port=')) {
      const p = Number(value());
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('--port must be a number from 1 to 65535');
      out.port = p;
    } else if (a === '--owner' || a.startsWith('--owner=')) out.owner = value();
    else if (a.startsWith('-')) throw new Error(`Unknown option ${a} (see --help)`);
    else if (out.path) throw new Error('Give one repository path at most');
    else out.path = a;
  }
  return out;
}

/** The nearest folder at or above `start` that holds a .beads folder, or null. */
export function findBeadsRoot(start) {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, '.beads');
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  execFile(cmd, args, () => {});
}

function hasBd(bin) {
  return new Promise((done) => execFile(bin, ['--version'], { timeout: 10000 }, (error) => done(!error)));
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`beads-explorer: ${error.message}`);
    process.exit(2);
  }
  if (args.help) { console.log(HELP); return; }
  if (args.version) {
    console.log(JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version);
    return;
  }

  const start = resolve(args.path ?? process.cwd());
  if (!existsSync(start)) { console.error(`beads-explorer: no such folder: ${start}`); process.exit(2); }
  const root = findBeadsRoot(start);
  if (!root) {
    console.error(`beads-explorer: no .beads folder in ${start} or any folder above it.\nRun it inside a repository that uses beads, pass its path, or create one with: bd init`);
    process.exit(2);
  }
  const bdBin = process.env.BEADS_EXPLORER_BD || 'bd';
  if (!(await hasBd(bdBin))) {
    console.error(`beads-explorer: the bd command was not found. Install beads (https://github.com/steveyegge/beads) or set BEADS_EXPLORER_BD to its path.`);
    process.exit(2);
  }

  const explicitPort = args.port ?? (process.env.BEADS_EXPLORER_PORT ? Number(process.env.BEADS_EXPLORER_PORT) : null);
  const owner = args.owner ?? process.env.BEADS_EXPLORER_OWNER ?? '';
  const { server } = createServer({ bdBin, cwd: root, owner, repoName: basename(root) });

  // Several repositories can be open at once: without an explicit port, the next free one is used.
  let port = explicitPort ?? 4410;
  const lastTry = explicitPort ? port : port + 20;
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE' && port < lastTry) { port++; server.listen(port, '127.0.0.1'); return; }
    console.error(error.code === 'EADDRINUSE' ? `beads-explorer: port ${port} is busy; pass --port with another one.` : `beads-explorer: ${error.message}`);
    process.exit(1);
  });
  server.on('listening', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`Beads Explorer for ${basename(root)} (${root})\n${url}  (Ctrl-C to stop)`);
    if (args.open && !process.env.BEADS_EXPLORER_NO_OPEN) openBrowser(url);
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 2500).unref();
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
  server.listen(port, '127.0.0.1');
}

// Run when started as a command (npm links the bin through a symlink, so compare real paths), not when imported by the tests.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
