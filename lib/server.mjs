// Beads Explorer: a local web app over the bd CLI of whichever repository it is started in (see bin/beads-explorer.mjs).
// Listens on 127.0.0.1 only, answers only requests addressed to 127.0.0.1 or localhost on its own port (no DNS rebinding),
// and every API call needs the per-run token the page is served with.
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BadRequest, Conflict, bdArgs, bdClient, parseJson, validateCreate, validateId, validateIds, validateKey, validatePatch, validateText } from './bd.mjs';
import { API_MODEL, NO_SESSION_RE, anthropicEvents, childEnv, claudeArgs, issueContext, parseClaudeLine, systemPromptFor, userTurn } from './chat.mjs';
import { blockersOf, childrenOf, normalizeIssues } from './model.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(HERE, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const VENDOR = ['marked.min.js', 'purify.min.js', 'cytoscape.min.js', 'dagre.min.js', 'cytoscape-dagre.js'];
// An exact allowlist of served files, so no request path ever reaches the file system.
const STATIC = new Map([
  ['/app.js', join(PUBLIC, 'app.js')], ['/styles.css', join(PUBLIC, 'styles.css')], ['/favicon.svg', join(PUBLIC, 'favicon.svg')],
  ['/model.mjs', join(HERE, 'model.mjs')], ...VENDOR.map((f) => [`/vendor/${f}`, join(PUBLIC, 'vendor', f)]),
]);
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const CACHE_MS = 3000;
const MAX_BODY = 256 * 1024;
const CHAT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * @param {{ bdBin?: string, cwd?: string, token?: string, port?: number | null, claudeBin?: string, apiKey?: string, owner?: string, repoName?: string }} [options]
 */
export function createServer({
  bdBin, cwd = process.cwd(), token = randomBytes(24).toString('hex'), port = null,
  claudeBin = process.env.BEADS_EXPLORER_CLAUDE || 'claude', apiKey = process.env.ANTHROPIC_API_KEY,
  owner = '', repoName = basename(cwd),
} = {}) {
  const bd = bdClient({ bin: bdBin, cwd });
  const tokenBuf = Buffer.from(token);
  const chatting = new Set();
  const children = new Set();
  const snapshotDir = mkdtempSync(join(tmpdir(), 'beads-ui-'));
  const cwdKey = createHash('sha256').update(cwd).digest('hex').slice(0, 12);
  let boundPort = port;
  let cache = null;
  const invalidate = () => { cache = null; };

  async function allIssues() {
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
    const issues = parseJson(await bd.read(bdArgs.list()));
    cache = { at: Date.now(), data: { issues, fetchedAt: new Date().toISOString() } };
    return cache.data;
  }

  async function issueWithComments(id) {
    const [issue] = parseJson(await bd.read(bdArgs.get([id])));
    if (!issue) throw Object.assign(new Error(`No issue ${id}`), { status: 404 });
    const comments = await bd.read(bdArgs.comments(id)).then(parseJson).catch(() => []);
    return { ...issue, comments };
  }

  /**
   * One read, the conflict check and the write, with nothing else let into the bd queue between them.
   * A change of status on a closed issue goes through bd reopen first, which clears closed_at.
   */
  function applyPatch(ids, { patch, expectedUpdatedAt }) {
    return bd.exclusive(async (q) => {
      const current = parseJson(await q.read(bdArgs.get(ids)));
      if (current.length !== ids.length) throw Object.assign(new Error(`No issue ${ids.find((id) => !current.some((i) => i.id === id))}`), { status: 404 });
      const changed = expectedUpdatedAt && current.find((i) => i.updated_at && i.updated_at !== expectedUpdatedAt);
      if (changed) throw new Conflict(`${changed.id} changed since you opened it (in another session or from the terminal). It has been reloaded; check it and try again.`);
      if (patch.status) {
        const closed = current.filter((i) => i.status === 'closed').map((i) => i.id);
        if (closed.length) await q.write(bdArgs.reopen(closed));
        if (patch.status === 'open' && Object.keys(patch).length === 1 && closed.length === ids.length) return;
      }
      await q.write(bdArgs.update(ids, patch));
    });
  }

  function closeIssues(ids, { reason, force, expectedUpdatedAt }) {
    return bd.exclusive(async (q) => {
      if (expectedUpdatedAt) {
        const current = parseJson(await q.read(bdArgs.get(ids)));
        const changed = current.find((i) => i.updated_at && i.updated_at !== expectedUpdatedAt);
        if (changed) throw new Conflict(`${changed.id} changed since you opened it. It has been reloaded; check it and try again.`);
      }
      await q.write(bdArgs.close(ids, reason, force));
    });
  }

  function closeFields(body) {
    if (body?.expectedUpdatedAt !== undefined && typeof body.expectedUpdatedAt !== 'string') throw new BadRequest('expectedUpdatedAt must be a date string');
    return { reason: validateText(body?.reason ?? '', 'reason', { required: true }), force: body?.force === true, expectedUpdatedAt: body?.expectedUpdatedAt };
  }

  const routes = [
    ['GET', /^\/api\/issues$/, async () => allIssues()],
    ['GET', /^\/api\/issues\/([^/]+)$/, async ({ params }) => issueWithComments(validateId(params[0]))],
    ['PATCH', /^\/api\/issues\/([^/]+)$/, async ({ params, body }) => {
      const id = validateId(params[0]);
      await applyPatch([id], validatePatch(body));
      invalidate();
      return issueWithComments(id);
    }],
    ['POST', /^\/api\/issues\/([^/]+)\/close$/, async ({ params, body }) => {
      const id = validateId(params[0]);
      await closeIssues([id], closeFields(body));
      invalidate();
      return issueWithComments(id);
    }],
    ['POST', /^\/api\/bulk$/, async ({ body }) => {
      const ids = validateIds(body?.ids);
      try {
        if (body?.close) await closeIssues(ids, closeFields(body));
        else await applyPatch(ids, validatePatch(body?.patch));
      } finally {
        invalidate();
      }
      return { ok: true, count: ids.length };
    }],
    ['POST', /^\/api\/issues\/([^/]+)\/comments$/, async ({ params, body }) => {
      const id = validateId(params[0]);
      await bd.write(bdArgs.addComment(id, validateText(body?.text ?? '', 'comment', { required: true })));
      invalidate();
      return issueWithComments(id);
    }],
    ['POST', /^\/api\/issues$/, async ({ body }) => {
      const fields = validateCreate(body);
      const created = parseJson(await bd.write(bdArgs.create(fields)));
      invalidate();
      return Array.isArray(created) ? created[0] : created;
    }],
    ['POST', /^\/api\/deps$/, async ({ body }) => {
      const issue = validateId(body?.issue);
      const dependsOn = validateId(body?.dependsOn);
      if (issue === dependsOn) throw new BadRequest('An issue cannot depend on itself');
      await bd.write(bdArgs.depAdd(issue, dependsOn));
      invalidate();
      return { ok: true };
    }],
    ['DELETE', /^\/api\/deps$/, async ({ body }) => {
      await bd.write(bdArgs.depRemove(validateId(body?.issue), validateId(body?.dependsOn)));
      invalidate();
      return { ok: true };
    }],
    ['GET', /^\/api\/memories$/, async () => ({ memories: memoryList(parseJson(await bd.read(bdArgs.memories()))) })],
    ['PUT', /^\/api\/memories\/([^/]+)$/, async ({ params, body }) => {
      const key = validateKey(decodePart(params[0]));
      const text = validateText(body?.text ?? '', 'memory', { required: true });
      if (body?.expectedText !== undefined && typeof body.expectedText !== 'string') throw new BadRequest('expectedText must be text');
      await bd.exclusive(async (q) => {
        // A memory edited in another session since this page loaded it is not overwritten.
        if (typeof body?.expectedText === 'string' || body?.create === true) {
          const now = parseJson(await q.read(bdArgs.memories()))[key];
          if (body.create === true && now !== undefined) throw new Conflict(`A memory with the key ${key} already exists. Pick another key, or edit that memory.`);
          if (body.create !== true && (now ?? '') !== body.expectedText) throw new Conflict(`Memory ${key} changed since you opened it. It has been reloaded; check it and try again.`);
        }
        await q.write(bdArgs.remember(key, text));
      });
      return { ok: true };
    }],
    ['DELETE', /^\/api\/memories\/([^/]+)$/, async ({ params }) => {
      await bd.write(bdArgs.forget(validateKey(decodePart(params[0]))));
      return { ok: true };
    }],
    ['GET', /^\/api\/sync$/, async () => {
      const out = await bd.read(bdArgs.remotes()).catch((e) => e.message);
      return { hasRemote: !/no remotes/i.test(out) && out.trim().length > 0 };
    }],
    ['POST', /^\/api\/sync$/, async () => {
      try { return { ok: true, output: await bd.write(bdArgs.sync()) }; } catch (error) { return { ok: false, output: error.message }; }
    }],
    ['GET', /^\/api\/chat\/status$/, async () => {
      if (apiKey) return { mode: 'api', model: API_MODEL, cwdKey };
      const status = await run(claudeBin, ['auth', 'status'], { env: childEnv() });
      if (status.missing) return { mode: 'none', reason: 'missing', cwdKey };
      let loggedIn = false;
      try { loggedIn = JSON.parse(status.stdout).loggedIn === true; } catch { loggedIn = !status.error; }
      return { mode: 'cli', loggedIn, cwdKey };
    }],
  ];

  async function chatInputs(id, mode) {
    const { issues } = await allIssues();
    const model = normalizeIssues(issues);
    const issue = model.byId.get(id);
    if (!issue) throw Object.assign(new Error(`No issue ${id}`), { status: 404 });
    const dependents = model.issues.filter((i) => i.dependencies.some((d) => d.type === 'blocks' && (d.depends_on_id ?? d.id) === id));
    const comments = await bd.read(bdArgs.comments(id)).then(parseJson).catch(() => []);
    const log = await run('git', ['log', '--oneline', '-n', '20', '--fixed-strings', `--grep=${id}`], { cwd });
    let snapshotPath = null;
    if (mode === 'cli') {
      const memories = await bd.read(bdArgs.memories()).then(parseJson).catch(() => ({}));
      snapshotPath = join(snapshotDir, 'beads.json');
      writeFileSync(snapshotPath, JSON.stringify({ issues, memories }, null, 1));
    }
    const context = issueContext(issue, {
      parent: issue.parent ? model.byId.get(issue.parent) : null, blockers: blockersOf(issue, model.byId), dependents,
      children: childrenOf(id, model.issues), comments, commits: log.error ? [] : log.stdout.trim().split('\n').filter(Boolean),
    });
    return { context, systemPrompt: systemPromptFor({ mode, snapshotPath }) };
  }

  async function chat(req, res, id, body) {
    const message = validateText(body?.message ?? '', 'message', { required: true });
    if (chatting.has(id)) throw new Conflict('A reply about this issue is still being written. Wait for it or press Stop.');
    chatting.add(id);
    // The response closes when the page stops reading (Stop, a new chat, a closed tab); that is the signal to stop the run.
    // Listen from the start, so a Stop while the context is still being gathered is honoured too.
    const gone = new AbortController();
    res.on('close', () => gone.abort());
    try {
      const mode = apiKey ? 'api' : 'cli';
      const { context, systemPrompt } = await chatInputs(id, mode);
      if (gone.signal.aborted) return;
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-content-type-options': 'nosniff' });
      const send = (event) => { if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`); };
      try {
        if (mode === 'api') await chatViaApi({ gone, send, systemPrompt, prompt: userTurn(context, message), history: body?.history });
        else await chatViaCli({ gone, send, systemPrompt, prompt: userTurn(context, message), sessionId: body?.sessionId });
      } catch (error) {
        send({ type: 'error', message: error.message });
      }
      if (!res.writableEnded) res.end();
    } finally {
      chatting.delete(id);
    }
  }

  async function chatViaApi({ gone, send, systemPrompt, prompt, history }) {
    const past = Array.isArray(history) ? history.filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content).slice(-20) : [];
    const timer = setTimeout(() => { send({ type: 'error', message: 'The reply took longer than 5 minutes and was stopped.' }); gone.abort(); }, CHAT_TIMEOUT_MS);
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: gone.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: API_MODEL, max_tokens: 4096, stream: true, system: systemPrompt, messages: [...past, { role: 'user', content: prompt }] }),
      });
      if (!response.ok) return send({ type: 'error', message: `The API answered ${response.status}: ${(await response.text()).slice(0, 300)}`, auth: response.status === 401 });
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const cut = buffer.lastIndexOf('\n\n');
        if (cut < 0) continue;
        for (const event of anthropicEvents(buffer.slice(0, cut))) send(event);
        buffer = buffer.slice(cut + 2);
      }
      for (const event of anthropicEvents(buffer)) send(event);
    } catch (error) {
      if (!gone.signal.aborted) send({ type: 'error', message: error.message });
    } finally {
      clearTimeout(timer);
    }
  }

  async function chatViaCli({ gone, send, systemPrompt, prompt, sessionId }) {
    const resume = typeof sessionId === 'string' && /^[0-9a-f-]{36}$/.test(sessionId);
    const first = await cliTurn({ gone, send, systemPrompt, prompt, sessionId: resume ? sessionId : randomUUID(), resume });
    // An old or foreign session (another worktree, a cleared history) cannot be resumed: start a fresh one once.
    if (first.noSession && !gone.signal.aborted) {
      send({ type: 'tool', name: 'note', detail: 'The earlier conversation could not be resumed; starting a new one.' });
      await cliTurn({ gone, send, systemPrompt, prompt, sessionId: randomUUID(), resume: false });
    }
  }

  function cliTurn({ gone, send, systemPrompt, prompt, sessionId, resume }) {
    return new Promise((resolve) => {
      const child = spawn(claudeBin, claudeArgs({ sessionId, resume, systemPrompt, addDir: snapshotDir, model: process.env.BEADS_EXPLORER_MODEL }), {
        cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'], detached: true,
      });
      children.add(child);
      let settled = false;
      let final = null;
      let stderr = '';
      let buffer = '';
      const stop = () => killTree(child);
      const done = (result = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        gone.signal.removeEventListener('abort', stop);
        resolve(result);
      };
      const timer = setTimeout(() => { send({ type: 'error', message: 'The reply took longer than 5 minutes and was stopped.' }); stop(); }, CHAT_TIMEOUT_MS);
      if (gone.signal.aborted) stop(); else gone.signal.addEventListener('abort', stop, { once: true });
      child.on('error', (error) => {
        send({ type: 'error', message: error.code === 'ENOENT' ? 'The claude command was not found. Install Claude Code, or start this tool with ANTHROPIC_API_KEY set.' : error.message });
        done();
      });
      // A run that exits before reading its message must not take the server down with EPIPE.
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
      child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
      child.stdout.on('data', (d) => {
        buffer += d;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const l of lines) {
          const event = parseClaudeLine(l);
          if (!event) continue;
          if (event.type === 'error' && event.noSession && resume) { final = { noSession: true }; continue; }
          if (event.type === 'done') { final = {}; send({ ...event, sessionId: event.sessionId ?? sessionId }); continue; }
          if (event.type === 'error') final = {};
          send(event);
        }
      });
      child.on('close', (code) => {
        children.delete(child);
        // A stale session can also fail on stderr only ("No conversation found", exit 1): retry it like the stream-json case.
        if (!final && resume && code !== 0 && NO_SESSION_RE.test(stderr)) final = { noSession: true };
        if (!final && !gone.signal.aborted) send(code === 0 ? { type: 'done', sessionId } : { type: 'error', message: stderr.trim() || `claude exited with code ${code}` });
        done(final ?? {});
      });
    });
  }

  function hostAllowed(req) {
    const host = req.headers.host ?? '';
    const p = boundPort ?? req.socket.localPort;
    return host === `127.0.0.1:${p}` || host === `localhost:${p}`;
  }

  function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    const p = boundPort ?? req.socket.localPort;
    return origin === `http://127.0.0.1:${p}` || origin === `http://localhost:${p}`;
  }

  function tokenOk(req) {
    const given = Buffer.from(String(req.headers['x-beads-token'] ?? ''));
    return given.length === tokenBuf.length && timingSafeEqual(given, tokenBuf);
  }

  async function handle(req, res) {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    try {
      if (!hostAllowed(req)) return sendJson(res, 403, { error: 'Open Beads Explorer at http://127.0.0.1 or http://localhost on its own port.' });
      if (req.method === 'OPTIONS') return sendJson(res, 405, { error: 'Method not allowed' });
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        const html = (await readFile(join(PUBLIC, 'index.html'), 'utf8'))
          .replace('__BEADS_UI_TOKEN__', token).replace('__BEADS_UI_REPO__', escapeAttr(repoName)).replace('__BEADS_UI_OWNER__', escapeAttr(owner))
          .replace('__BEADS_UI_ROOT__', () => escapeAttr(cwd));
        return sendRaw(res, 200, html, TYPES['.html']);
      }
      if (req.method === 'GET' && STATIC.has(path)) {
        const file = STATIC.get(path);
        return sendRaw(res, 200, await readFile(file), TYPES[extname(file)] ?? 'application/octet-stream');
      }
      if (!path.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
      // Every API call, reads included, needs the token: another page in the browser cannot make the server queue bd or claude runs.
      if (!originAllowed(req) || !tokenOk(req)) return sendJson(res, 403, { error: 'Missing or wrong token; reload the page.' });
      const body = req.method === 'GET' ? null : await readBody(req);
      const chatMatch = path.match(/^\/api\/chat\/([^/]+)$/);
      if (req.method === 'POST' && chatMatch && chatMatch[1] !== 'status') return await chat(req, res, validateId(decodePart(chatMatch[1])), body);
      for (const [method, re, fn] of routes) {
        const m = path.match(re);
        if (m && method === req.method) return sendJson(res, 200, await fn({ params: m.slice(1).map(decodePart), body }));
      }
      return sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      if (res.headersSent) return res.end();
      const status = error instanceof BadRequest ? (error.tooLarge ? 413 : 400) : error instanceof Conflict ? 409 : error.status ?? (error.bd ? (error.missing ? 503 : 502) : 500);
      const message = error.missing ? 'The bd command was not found. Install beads, or set BEADS_EXPLORER_BD to its path.' : error.message;
      if (error.tooLarge) res.setHeader('connection', 'close');
      return sendJson(res, status, { error: message });
    }
  }

  const server = createHttpServer((req, res) => { handle(req, res); });
  server.on('listening', () => { boundPort = server.address().port; });
  server.on('close', () => {
    for (const child of children) killTree(child);
    rmSync(snapshotDir, { recursive: true, force: true });
  });
  return { server, token, children };
}

/** Stops a detached claude run and everything it started; SIGKILL follows if it ignores SIGTERM. */
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { return; }
  setTimeout(() => { if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } } }, 2000).unref();
}

function escapeAttr(text) {
  return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function decodePart(part) {
  try { return decodeURIComponent(part); } catch { throw new BadRequest('Malformed address'); }
}

function memoryList(map) {
  return Object.entries(map).filter(([k, v]) => k !== 'schema_version' && typeof v === 'string').map(([key, text]) => ({ key, text }));
}

function sendRaw(res, status, body, type) {
  res.writeHead(status, {
    'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY', 'content-security-policy': CSP, 'cross-origin-opener-policy': 'same-origin', 'cross-origin-resource-policy': 'same-origin',
  });
  res.end(body);
}

function sendJson(res, status, value) {
  sendRaw(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

/** Reads a JSON body; a body over the limit is answered with 413 (the rest is not read and the connection closes). */
function readBody(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) {
      req.resume();
      return reject(Object.assign(new BadRequest('Request too large'), { tooLarge: true }));
    }
    let size = 0;
    let failed = false;
    const chunks = [];
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > MAX_BODY) { failed = true; reject(Object.assign(new BadRequest('Request too large'), { tooLarge: true })); } else chunks.push(c);
    });
    req.on('end', () => {
      if (failed) return;
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new BadRequest('Body must be JSON')); }
    });
    req.on('error', reject);
  });
}

function run(bin, args, { cwd, env } = {}) {
  return new Promise((resolve) => execFile(bin, args, { cwd, env, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) =>
    resolve({ error, stdout: String(stdout ?? ''), missing: error?.code === 'ENOENT' })));
}
