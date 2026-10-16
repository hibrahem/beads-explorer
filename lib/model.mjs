// Pure functions over bd issues, shared by the server and the browser (no Node or DOM imports).

export const STATUSES = ['open', 'in_progress', 'blocked', 'deferred', 'pinned', 'hooked', 'closed'];
export const PRIORITIES = [0, 1, 2, 3, 4];
export const TYPES = ['task', 'bug', 'feature', 'chore', 'epic', 'decision', 'spike', 'story', 'milestone'];
export const UPDATABLE_TEXT = ['title', 'description', 'design', 'acceptance', 'notes', 'assignee'];

// Shapes bd accepts; the server refuses anything else before bd ever runs.
// A prefix may hold hyphens and underscores (bd derives it from the folder name, e.g. al_rasikhoon-hk0).
const ID_RE = /^[a-z0-9][a-z0-9_-]*-[a-z0-9]+(\.[a-z0-9]+)*$/;
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,40}$/;
export const isIssueId = (v) => typeof v === 'string' && ID_RE.test(v);
export const isMemoryKey = (v) => typeof v === 'string' && KEY_RE.test(v);
export const isLabel = (v) => typeof v === 'string' && LABEL_RE.test(v);

const STALE_DAYS = 14;
const RECENT_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;

/** @typedef {Record<string, any>} Issue */
/** @typedef {{ issues: Issue[], byId: Map<string, Issue> }} Model */

/**
 * Fills missing arrays and indexes the issues by id.
 * @param {any[]} raw
 * @returns {Model}
 */
export function normalizeIssues(raw) {
  const issues = raw.map((i) => ({
    ...i,
    labels: Array.isArray(i.labels) ? i.labels : [],
    dependencies: Array.isArray(i.dependencies) ? i.dependencies : [],
    priority: Number.isInteger(i.priority) ? i.priority : 2,
  }));
  return { issues, byId: new Map(issues.map((i) => [i.id, i])) };
}

/** The ids this issue is blocked by (`blocks` rows where it is the dependent). */
function blockerIds(issue) {
  return issue.dependencies.filter((d) => d.type === 'blocks' && (d.issue_id ?? issue.id) === issue.id).map((d) => d.depends_on_id ?? d.id);
}

/**
 * Blockers that are not closed: what still stands in the way.
 * @param {Issue} issue
 * @param {Map<string, Issue>} byId
 * @returns {Issue[]}
 */
export function blockersOf(issue, byId) {
  return blockerIds(issue).map((id) => byId.get(id)).filter((b) => b && b.status !== 'closed');
}

/** An open blocker on the issue itself or on any of its parents (bd carries a parent's block down to its children). */
function blockedWithAncestors(issue, byId) {
  const seen = new Set();
  for (let at = issue; at && !seen.has(at.id); at = at.parent ? byId.get(at.parent) : null) {
    seen.add(at.id);
    if (blockersOf(at, byId).length > 0) return true;
  }
  return false;
}

export function isBlocked(issue, byId) {
  if (issue.status === 'closed') return false;
  return issue.status === 'blocked' || blockedWithAncestors(issue, byId);
}

/** bd ready: open, nothing open blocking it or its parents, and not deferred to a later date. */
export function isReady(issue, byId, now = new Date()) {
  if (issue.status !== 'open') return false;
  if (issue.defer_until && new Date(issue.defer_until) > now) return false;
  return !blockedWithAncestors(issue, byId);
}

/** @param {string} parentId @param {Issue[]} issues @returns {Issue[]} */
export function childrenOf(parentId, issues) {
  return issues.filter((i) => i.parent === parentId).sort((a, b) => compareIds(a.id, b.id));
}

export function epicProgress(epicId, issues) {
  const kids = childrenOf(epicId, issues);
  const closed = kids.filter((k) => k.status === 'closed').length;
  return { total: kids.length, closed, percent: kids.length ? Math.round((closed / kids.length) * 100) : 0 };
}

/** Natural order for ids like tm-3gs.9 < tm-3gs.10. */
export function compareIds(a, b) {
  return a.localeCompare(b, 'en', { numeric: true });
}

/**
 * Nodes and edges for the dependency graph. Edges point from the blocker (or parent) to the issue that waits on it.
 * options: includeParents, includeClosed, focus (an id), depth (levels of neighbours around the focus).
 * @param {Model} model
 * @param {{ includeParents?: boolean, includeClosed?: boolean, focus?: string | null, depth?: number }} [options]
 * @returns {{ nodes: any[], edges: { id: string, source: string, target: string, kind: string }[] }}
 */
export function buildGraph({ issues, byId }, { includeParents = true, includeClosed = false, focus = null, depth = 2 } = {}) {
  const edges = [];
  for (const i of issues) {
    for (const d of i.dependencies) {
      const from = d.depends_on_id ?? d.id;
      if ((d.issue_id ?? i.id) !== i.id || !byId.has(from)) continue;
      if (d.type === 'blocks') edges.push({ id: `blocks:${from}->${i.id}`, source: from, target: i.id, kind: 'blocks' });
      else if (d.type === 'parent-child' && includeParents) edges.push({ id: `parent:${from}->${i.id}`, source: from, target: i.id, kind: 'parent' });
    }
  }
  let keep = new Set(issues.filter((i) => includeClosed || i.status !== 'closed').map((i) => i.id));
  if (focus && byId.has(focus)) {
    const around = new Set([focus]);
    let frontier = [focus];
    for (let level = 0; level < depth; level++) {
      const next = [];
      for (const e of edges) {
        for (const [a, b] of [[e.source, e.target], [e.target, e.source]]) {
          if (frontier.includes(a) && !around.has(b) && keep.has(b)) { around.add(b); next.push(b); }
        }
      }
      frontier = next;
    }
    keep = around;
  }
  const kept = edges.filter((e) => keep.has(e.source) && keep.has(e.target));
  const nodes = [...keep].map((id) => {
    const i = byId.get(id);
    return { id, title: i.title, status: i.status, priority: i.priority, type: i.issue_type, ready: isReady(i, byId), blocked: isBlocked(i, byId) };
  });
  return { nodes, edges: kept };
}

export function matchesQuery(issue, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [issue.id, issue.title, issue.description, issue.notes, issue.design, issue.acceptance_criteria, issue.assignee, ...issue.labels]
    .some((v) => typeof v === 'string' && v.toLowerCase().includes(q));
}

export function filterIssues(issues, { query = '', statuses = [], priorities = [], types = [], label = '', parent = '' } = {}) {
  return issues.filter((i) =>
    matchesQuery(i, query)
    && (!statuses.length || statuses.includes(i.status))
    && (!priorities.length || priorities.includes(i.priority))
    && (!types.length || types.includes(i.issue_type))
    && (!label || i.labels.includes(label))
    && (!parent || i.parent === parent || i.id === parent));
}

/**
 * @param {Model} model
 * @param {Date} [now]
 * @param {{ owner?: string }} [options] owner: issues titled "<owner>: …" or labelled with the owner's name are waiting on them
 * @returns {{ byStatus: Record<string, number>, byPriority: Record<string, number>, byType: Record<string, number>, ready: Issue[], blocked: Issue[], stale: Issue[], recentlyClosed: Issue[], forOwner: Issue[], urgent: Issue[] }}
 */
export function insights({ issues, byId }, now = new Date(), { owner = '' } = {}) {
  const count = (key) => issues.reduce((acc, i) => ({ ...acc, [i[key]]: (acc[i[key]] ?? 0) + 1 }), {});
  const open = issues.filter((i) => i.status !== 'closed');
  const ageDays = (iso) => (now - new Date(iso)) / DAY;
  return {
    byStatus: count('status'),
    byPriority: count('priority'),
    byType: count('issue_type'),
    ready: open.filter((i) => isReady(i, byId, now)).sort(byPriorityThenId),
    blocked: open.filter((i) => isBlocked(i, byId)).sort(byPriorityThenId),
    stale: open.filter((i) => i.updated_at && ageDays(i.updated_at) > STALE_DAYS).sort(byPriorityThenId),
    recentlyClosed: issues.filter((i) => i.status === 'closed' && i.closed_at && ageDays(i.closed_at) <= RECENT_DAYS)
      .sort((a, b) => String(b.closed_at).localeCompare(String(a.closed_at))),
    forOwner: owner ? open.filter((i) => i.title.toLowerCase().startsWith(`${owner.toLowerCase()}:`) || i.labels.some((l) => l.toLowerCase() === owner.toLowerCase())).sort(byPriorityThenId) : [],
    urgent: open.filter((i) => i.priority <= 1).sort(byPriorityThenId),
  };
}

export function byPriorityThenId(a, b) {
  return a.priority - b.priority || compareIds(a.id, b.id);
}

/**
 * The AI ends a reply with a ```beads-update {json}``` block when it suggests a change.
 * Returns only the allowed, valid fields of the last block, or null.
 */
export function extractUpdateBlock(text) {
  const blocks = [...String(text).matchAll(/```beads-update\s*\n([\s\S]*?)```/g)];
  if (!blocks.length) return null;
  let raw;
  try { raw = JSON.parse(blocks[blocks.length - 1][1]); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  if ('status' in raw) {
    if (!STATUSES.includes(raw.status)) return null;
    out.status = raw.status;
  }
  if ('priority' in raw) {
    if (!PRIORITIES.includes(raw.priority)) return null;
    out.priority = raw.priority;
  }
  // Notes are appended, never replaced: they often hold another session's handoff.
  for (const k of ['title', 'description', 'assignee']) if (typeof raw[k] === 'string') out[k] = raw[k];
  if (typeof raw.notes === 'string' && raw.notes.trim()) out.appendNotes = raw.notes;
  return Object.keys(out).length ? out : null;
}
