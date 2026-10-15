import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../lib/server.mjs';

// Stand-ins for bd and claude: they log their arguments (and claude its stdin) and answer with fixtures.
const dir = mkdtempSync(join(tmpdir(), 'beads-ui-'));
const log = join(dir, 'calls.log');
const fakeBd = join(dir, 'bd');
writeFileSync(fakeBd, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const make = (id) => ({ id, title: id.toUpperCase(), status: id === 'tm-c' ? 'closed' : 'open', priority: 2, issue_type: 'task', updated_at: '2026-10-15T10:00:00Z', dependencies: [] });
const idArg = args.find((a) => a.startsWith('--id='));
if (args[0] === 'list') console.log(JSON.stringify(idArg ? idArg.slice(5).split(',').filter((id) => id !== 'tm-gone').map(make) : [make('tm-a')]));
else if (args[0] === 'comments' && args[1] !== 'add') console.log('[]');
else if (args[0] === 'memories') console.log(JSON.stringify({ 'auth-jwt': 'JWT', schema_version: 1 }));
else if (args[0] === 'update' && args.includes('--status=deferred')) { console.error('Error: bd refused'); process.exit(1); }
else if (args[0] === 'close' && args.includes('tm-b')) { console.log('✓ Closed tm-a'); console.error('cannot close tm-b: blocked by open issues [tm-x] (use --force to override)'); }
else console.log('ok');
`);
chmodSync(fakeBd, 0o755);
const claudeLog = join(dir, 'claude.log');
const claudePid = join(dir, 'claude.pid');
const fakeClaude = join(dir, 'claude');
writeFileSync(fakeClaude, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_EXIT_AT_ONCE) process.exit(3);
fs.writeFileSync(${JSON.stringify(claudePid)}, String(process.pid));
let stdin = '';
process.stdin.on('data', (d) => { stdin += d; }).on('end', () => {
  fs.writeFileSync(${JSON.stringify(claudeLog)}, JSON.stringify({ args, stdin, env: Object.keys(process.env).filter((k) => k.startsWith('CLAUDE')) }));
  const out = (o) => console.log(JSON.stringify(o));
  if (stdin.includes('please hang')) { out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Thinking' } } }); setInterval(() => {}, 1000); return; }
  out({ type: 'system', subtype: 'init', session_id: 'x' });
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Looks ' } } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'fine.' } } });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looks fine.' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, session_id: '11111111-2222-3333-4444-555555555555', result: 'Looks fine.' });
});
`);
chmodSync(fakeClaude, 0o755);

const TOKEN = 't0ken';
let base = '';
let port = 0;
let close: () => void;

beforeAll(async () => {
  process.env.CLAUDE_CODE_SESSION_ID = 'parent-session';
  const made = createServer({ bdBin: fakeBd, claudeBin: fakeClaude, cwd: dir, token: TOKEN, apiKey: undefined });
  await new Promise<void>((resolve) => made.server.listen(0, '127.0.0.1', resolve));
  port = (made.server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  close = () => made.server.close();
});
afterAll(() => { delete process.env.CLAUDE_CODE_SESSION_ID; close(); });

const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const get = (path: string) => fetch(base + path, { headers: { 'x-beads-token': TOKEN } });
const send = (path: string, method: string, body?: unknown, headers: Record<string, string> = { 'x-beads-token': TOKEN }) =>
  fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
/** A raw request, so the Host header can be set (fetch never lets a page choose it). */
const raw = (path: string, host: string, method = 'GET') => new Promise<number>((resolve, reject) => {
  const r = request({ host: '127.0.0.1', port, path, method, headers: { host, 'x-beads-token': TOKEN } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
  r.on('error', reject);
  r.end();
});
const events = (text: string) => text.split('\n\n').filter((e) => e.startsWith('data:')).map((e) => JSON.parse(e.slice(5)));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('the Beads Explorer server', () => {
  it('serves the page with its token and a strict content policy, and the issues to a caller with the token', async () => {
    const res = await fetch(base + '/');
    expect(await res.text()).toContain(TOKEN);
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await (await get('/api/issues')).json()).toMatchObject({ issues: [{ id: 'tm-a' }] });
  });

  it('answers only requests addressed to 127.0.0.1 or localhost on its port (no DNS rebinding)', async () => {
    expect(await raw('/', 'evil.example:1234')).toBe(403);
    expect(await raw('/api/issues', `evil.example:${port}`)).toBe(403);
    expect(await raw('/api/issues/tm-a', `evil.example:${port}`, 'PATCH')).toBe(403);
    expect(await raw('/', `localhost:${port}`)).toBe(200);
    expect(await raw('/api/issues', `127.0.0.1:${port}`, 'OPTIONS')).toBe(405);
  });

  it('serves only its own files', async () => {
    for (const path of ['/../server.mjs', '/vendor/../../bd.mjs', '/server.mjs', '/%2e%2e/bd.mjs']) expect((await fetch(base + path)).status).toBe(404);
  });

  it('refuses an API call without the token or from another origin, reads included, and runs nothing', async () => {
    writeFileSync(log, '');
    expect((await fetch(base + '/api/issues')).status).toBe(403);
    expect((await send('/api/issues/tm-a', 'PATCH', { status: 'in_progress' }, {})).status).toBe(403);
    expect((await send('/api/issues/tm-a', 'PATCH', { status: 'in_progress' }, { 'x-beads-token': TOKEN, origin: 'http://evil.example' })).status).toBe(403);
    expect(calls()).toEqual([]);
  });

  it('runs bd update with the bound flags when the token is right, and never bd show', async () => {
    writeFileSync(log, '');
    const res = await send('/api/issues/tm-a', 'PATCH', { status: 'in_progress', notes: '--status closed' });
    expect(res.status).toBe(200);
    expect(calls()).toContainEqual(['update', 'tm-a', '--status=in_progress', '--notes=--status closed']);
    expect(calls().some((c) => c[0] === 'show')).toBe(false);
  });

  it('reopens a closed issue before giving it another status', async () => {
    writeFileSync(log, '');
    expect((await send('/api/issues/tm-c', 'PATCH', { status: 'in_progress' })).status).toBe(200);
    const writes = calls().filter((c) => c[0] === 'reopen' || c[0] === 'update');
    expect(writes).toEqual([['reopen', 'tm-c'], ['update', 'tm-c', '--status=in_progress']]);
  });

  it('refuses an edit or a close when the issue changed since the page loaded it', async () => {
    writeFileSync(log, '');
    expect((await send('/api/issues/tm-a', 'PATCH', { priority: 1, expectedUpdatedAt: '2026-10-14T00:00:00Z' })).status).toBe(409);
    expect((await send('/api/issues/tm-a/close', 'POST', { reason: 'done', expectedUpdatedAt: '2026-10-14T00:00:00Z' })).status).toBe(409);
    expect(calls().some((c) => c[0] === 'update' || c[0] === 'close')).toBe(false);
    expect((await send('/api/issues/tm-a', 'PATCH', { priority: 1, expectedUpdatedAt: '2026-10-15T10:00:00Z' })).status).toBe(200);
  });

  it('refuses a bad id, field, address or oversized body, and passes bd\'s own error back', async () => {
    expect((await send('/api/issues/tm-a;rm', 'PATCH', { status: 'open' })).status).toBe(400);
    expect((await send('/api/issues/tm-a', 'PATCH', { owner: 'x' })).status).toBe(400);
    expect((await send('/api/memories/%E0%A4%A', 'DELETE')).status).toBe(400);
    expect((await send('/api/issues/tm-a/comments', 'POST', { text: 'x'.repeat(300 * 1024) })).status).toBe(413);
    const res = await send('/api/issues/tm-a', 'PATCH', { status: 'deferred' });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('bd refused');
  });

  it('changes several issues in one bd call, and reports ids bd refused even when it exits 0', async () => {
    writeFileSync(log, '');
    expect((await send('/api/bulk', 'POST', { ids: ['tm-a', 'tm-d'], patch: { priority: 3 } })).status).toBe(200);
    expect(calls()).toContainEqual(['update', 'tm-a', 'tm-d', '--priority=3']);
    const partial = await send('/api/bulk', 'POST', { ids: ['tm-a', 'tm-b'], close: true, reason: 'done' });
    expect(partial.status).toBe(502);
    expect((await partial.json()).error).toContain('cannot close tm-b');
    expect((await send('/api/bulk', 'POST', { ids: ['tm-a', 'tm-gone'], patch: { priority: 1 } })).status).toBe(404);
  });

  it('adds and removes links and deletes memories', async () => {
    writeFileSync(log, '');
    expect((await send('/api/deps', 'POST', { issue: 'tm-a', dependsOn: 'tm-d' })).status).toBe(200);
    expect((await send('/api/deps', 'DELETE', { issue: 'tm-a', dependsOn: 'tm-d' })).status).toBe(200);
    expect((await send('/api/deps', 'POST', { issue: 'tm-a', dependsOn: 'tm-a' })).status).toBe(400);
    expect((await send('/api/memories/auth-jwt', 'DELETE')).status).toBe(200);
    expect(calls()).toEqual([['dep', 'add', 'tm-a', 'tm-d', '--type=blocks'], ['dep', 'remove', 'tm-a', 'tm-d'], ['forget', 'auth-jwt']]);
  });

  it('lists memories without the schema version, saves one with its key, and refuses one changed since it was opened', async () => {
    expect(await (await get('/api/memories')).json()).toEqual({ memories: [{ key: 'auth-jwt', text: 'JWT' }] });
    writeFileSync(log, '');
    expect((await send('/api/memories/auth-jwt', 'PUT', { text: '- JWT, not sessions', expectedText: 'JWT' })).status).toBe(200);
    expect(calls()).toContainEqual(['remember', '--key=auth-jwt', '--', '- JWT, not sessions']);
    expect((await send('/api/memories/auth-jwt', 'PUT', { text: 'x', expectedText: 'something older' })).status).toBe(409);
    expect((await send('/api/memories/auth-jwt', 'PUT', { text: 'x', create: true })).status).toBe(409);
    expect((await send('/api/memories/new-key', 'PUT', { text: 'x', create: true })).status).toBe(200);
  });

  it('streams a chat reply from the read-only claude run, with the context and message on stdin', async () => {
    const res = await send('/api/chat/tm-a', 'POST', { message: '- is this still needed?' });
    const evs = events(await res.text());
    expect(evs.filter((e) => e.type === 'text').map((e) => e.delta).join('')).toBe('Looks fine.');
    expect(evs.at(-1)).toEqual({ type: 'done', sessionId: '11111111-2222-3333-4444-555555555555' });
    const seen = JSON.parse(readFileSync(claudeLog, 'utf8'));
    expect(seen.stdin).toContain('<issue-context>');
    expect(seen.stdin.endsWith('- is this still needed?')).toBe(true);
    expect(seen.args[seen.args.indexOf('--append-system-prompt') + 1]).not.toContain('Issue tm-a');
    expect(seen.args[seen.args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    expect(seen.args[seen.args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(seen.env).not.toContain('CLAUDE_CODE_SESSION_ID');
  });

  it('stops the claude run when the page stops reading, and lets the next message through', async () => {
    const controller = new AbortController();
    const res = await send('/api/chat/tm-a', 'POST', { message: 'please hang' }, { 'x-beads-token': TOKEN });
    const reader = res.body!.getReader();
    await reader.read();
    const pid = Number(readFileSync(claudePid, 'utf8'));
    expect(alive(pid)).toBe(true);
    await reader.cancel();
    controller.abort();
    for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive(pid)).toBe(false);
    const next = await send('/api/chat/tm-a', 'POST', { message: 'again' });
    expect(next.status).toBe(200);
    await next.text();
  });

  it('survives a claude run that exits before reading a long message', async () => {
    process.env.FAKE_CLAUDE_EXIT_AT_ONCE = '1';
    try {
      const res = await send('/api/chat/tm-a', 'POST', { message: 'x'.repeat(19000) });
      expect(events(await res.text()).at(-1)?.type).toBe('error');
    } finally {
      delete process.env.FAKE_CLAUDE_EXIT_AT_ONCE;
    }
    expect((await get('/api/issues')).status).toBe(200);
    expect(existsSync(dir)).toBe(true);
  });
});
