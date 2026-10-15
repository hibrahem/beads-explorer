// The bd bridge (infrastructure): validated input, argument arrays (never a shell), and one bd process at a time.
import { execFile } from 'node:child_process';
import { PRIORITIES, STATUSES, TYPES, UPDATABLE_TEXT, isIssueId, isLabel, isMemoryKey } from './model.mjs';

export class BadRequest extends Error {}
export class Conflict extends Error {}

const MAX_TEXT = 20000;

export function validateId(id) {
  if (!isIssueId(id)) throw new BadRequest(`Not an issue id: ${String(id).slice(0, 40)}`);
  return id;
}

export function validateIds(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 200) throw new BadRequest('Send 1 to 200 issue ids');
  return ids.map(validateId);
}

export function validateKey(key) {
  if (!isMemoryKey(key)) throw new BadRequest(`Not a memory key: ${String(key).slice(0, 40)}`);
  return key;
}

export function validateText(value, field, { required = false } = {}) {
  if (typeof value !== 'string') throw new BadRequest(`${field} must be text`);
  if (value.length > MAX_TEXT) throw new BadRequest(`${field} is longer than ${MAX_TEXT} characters`);
  if (required && !value.trim()) throw new BadRequest(`${field} is required`);
  return value;
}

function validateLabels(labels, field) {
  if (!Array.isArray(labels) || labels.some((l) => !isLabel(l))) throw new BadRequest(`${field} must be a list of labels (letters, digits, - _ . :)`);
  return labels;
}

/** Keeps only the fields bd update takes, each checked. `expectedUpdatedAt` is returned apart, for the conflict check. */
export function validatePatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest('Send a JSON object');
  const { expectedUpdatedAt, ...patch } = body;
  if (expectedUpdatedAt !== undefined && typeof expectedUpdatedAt !== 'string') throw new BadRequest('expectedUpdatedAt must be a date string');
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'status') {
      if (!STATUSES.includes(v) || v === 'closed') throw new BadRequest(v === 'closed' ? 'Close an issue with the close action, which takes a reason' : `Unknown status: ${v}`);
      out.status = v;
    } else if (k === 'priority') {
      if (!PRIORITIES.includes(v)) throw new BadRequest('Priority must be 0 to 4');
      out.priority = v;
    } else if (UPDATABLE_TEXT.includes(k)) {
      out[k] = validateText(v, k, { required: k === 'title' });
    } else if (k === 'appendNotes') {
      out.appendNotes = validateText(v, 'note', { required: true });
    } else if (k === 'addLabels' || k === 'removeLabels') {
      out[k] = validateLabels(v, k);
    } else if (k === 'parent') {
      out.parent = v === '' ? '' : validateId(v);
    } else {
      throw new BadRequest(`Field not editable here: ${k}`);
    }
  }
  if (!Object.keys(out).length) throw new BadRequest('Nothing to change');
  return { patch: out, expectedUpdatedAt };
}

export function validateCreate(body) {
  if (!body || typeof body !== 'object') throw new BadRequest('Send a JSON object');
  const out = { title: validateText(body.title, 'title', { required: true }).trim() };
  out.type = body.type ?? 'task';
  if (!TYPES.includes(out.type)) throw new BadRequest(`Unknown type: ${out.type}`);
  out.priority = body.priority ?? 2;
  if (!PRIORITIES.includes(out.priority)) throw new BadRequest('Priority must be 0 to 4');
  if (body.description) out.description = validateText(body.description, 'description');
  if (body.parent) out.parent = validateId(body.parent);
  return out;
}

const FLAG = { status: 'status', priority: 'priority', title: 'title', description: 'description', design: 'design', acceptance: 'acceptance', notes: 'notes', assignee: 'assignee', parent: 'parent', appendNotes: 'append-notes' };

/**
 * Argument arrays for bd. Flag values are bound with `=` and positional text follows `--`, so no text is read as a flag.
 * One issue is read with `bd list --id`, never `bd show`: show rewrites .beads/last-touched, which id-less bd commands in other sessions act on.
 */
export const bdArgs = {
  list: () => ['list', '--all', '--json', '--limit', '0'],
  get: (ids) => ['list', '--all', '--json', '--limit', '0', `--id=${ids.join(',')}`],
  comments: (id) => ['comments', id, '--json'],
  addComment: (id, text) => ['comments', 'add', id, '--', text],
  update: (ids, patch) => {
    const args = ['update', ...someIds(ids)];
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'addLabels') args.push(...v.map((l) => `--add-label=${l}`));
      else if (k === 'removeLabels') args.push(...v.map((l) => `--remove-label=${l}`));
      else args.push(`--${FLAG[k]}=${v}`);
    }
    return args;
  },
  close: (ids, reason, force = false) => ['close', ...someIds(ids), `--reason=${reason}`, ...(force ? ['--force'] : [])],
  reopen: (ids) => ['reopen', ...someIds(ids)],
  create: ({ title, type, priority, description, parent }) => [
    'create', '--json', `--title=${title}`, `--type=${type}`, `--priority=${priority}`,
    ...(description ? [`--description=${description}`] : []), ...(parent ? [`--parent=${parent}`] : []),
  ],
  depAdd: (issue, dependsOn) => ['dep', 'add', issue, dependsOn, '--type=blocks'],
  depRemove: (issue, dependsOn) => ['dep', 'remove', issue, dependsOn],
  memories: () => ['memories', '--json'],
  remember: (key, text) => ['remember', `--key=${key}`, '--', text],
  forget: (key) => ['forget', key],
  remotes: () => ['dolt', 'remote', 'list'],
  sync: () => ['dolt', 'push'],
};

/** bd acts on the last-touched issue when given no id, so a write without ids is a bug, never a request. */
function someIds(ids) {
  const list = [ids].flat().filter(Boolean);
  if (!list.length) throw new BadRequest('No issue ids given');
  return list;
}

/** bd exits 0 when some of several ids were refused; those refusals are printed as "Error…" or "cannot…" lines. */
export function refusalsIn(output) {
  return String(output).split('\n').map((l) => l.trim()).filter((l) => /^(error|cannot)\b/i.test(l));
}

export function parseJson(text) {
  const start = text.search(/[[{]/);
  if (start < 0) throw new Error('bd returned no JSON');
  return JSON.parse(text.slice(start));
}

/**
 * Runs bd one process at a time: embedded Dolt holds one exclusive lock, so parallel calls only queue inside bd.
 * Identical reads that are already waiting share one run.
 */
export function bdClient({ bin = process.env.BEADS_EXPLORER_BD || 'bd', cwd = process.cwd(), timeoutMs = 60000, maxWaiting = 50 } = {}) {
  let tail = Promise.resolve();
  let waiting = 0;
  const waitingReads = new Map();

  /** Runs one bd process. A write whose output names refusals is a failure even when bd exits 0 (some of several ids refused). */
  function exec(args, { write = false } = {}) {
    return new Promise((resolve, reject) => {
      execFile(bin, args, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } }, (error, stdout, stderr) => {
        if (error) {
          const timedOut = error.killed || error.signal === 'SIGTERM';
          const message = timedOut ? `bd ${args[0]} took longer than ${timeoutMs / 1000} s (another bd process may hold the database)`
            : (stderr || stdout || error.message).toString().trim().split('\n').slice(-5).join('\n');
          return reject(Object.assign(new Error(message || `bd ${args[0]} failed`), { bd: true, missing: error.code === 'ENOENT' }));
        }
        // Lines that merely echo text the caller sent (a reason or note starting "Error…") are not refusals.
        const own = args.join('\n');
        const refused = write ? refusalsIn(`${stderr}\n${stdout}`).filter((l) => !own.includes(l)) : [];
        if (refused.length) return reject(Object.assign(new Error(`bd refused: ${refused.join(' · ')}`), { bd: true, partial: true }));
        resolve(stdout.toString());
      });
    });
  }

  function enqueue(task) {
    if (waiting >= maxWaiting) return Promise.reject(Object.assign(new Error('Too many bd calls are waiting; try again in a moment.'), { status: 503 }));
    waiting++;
    const run = tail.then(task, task).finally(() => { waiting--; });
    tail = run.catch(() => {});
    return run;
  }

  return {
    read(args) {
      const key = JSON.stringify(args);
      if (waitingReads.has(key)) return waitingReads.get(key);
      const run = enqueue(() => exec(args)).finally(() => waitingReads.delete(key));
      waitingReads.set(key, run);
      return run;
    },
    write: (args) => enqueue(() => exec(args, { write: true })),
    /** Holds the queue for a read-check-write sequence, so no other bd call runs between the check and the write. */
    exclusive: (fn) => enqueue(() => fn({ read: (args) => exec(args), write: (args) => exec(args, { write: true }) })),
  };
}
