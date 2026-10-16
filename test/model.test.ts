import { describe, expect, it } from 'vitest';
import {
  isIssueId,
  isLabel,
  isMemoryKey,
  blockersOf,
  buildGraph,
  childrenOf,
  epicProgress,
  extractUpdateBlock,
  insights,
  isBlocked,
  isReady,
  matchesQuery,
  normalizeIssues,
} from '../lib/model.mjs';

const NOW = new Date('2026-10-15T12:00:00Z');

function issue(id: string, extra: Record<string, unknown> = {}) {
  return { id, title: `Title ${id}`, status: 'open', priority: 2, issue_type: 'task', updated_at: '2026-10-14T00:00:00Z', dependencies: [], ...extra };
}
const blocks = (from: string, on: string) => ({ issue_id: from, depends_on_id: on, type: 'blocks' });
const child = (from: string, parent: string) => ({ issue_id: from, depends_on_id: parent, type: 'parent-child' });

function fixture() {
  return normalizeIssues([
    issue('tm-e', { issue_type: 'epic' }),
    issue('tm-e.1', { parent: 'tm-e', dependencies: [child('tm-e.1', 'tm-e')], status: 'closed' }),
    issue('tm-e.2', { parent: 'tm-e', dependencies: [child('tm-e.2', 'tm-e'), blocks('tm-e.2', 'tm-e.1')] }),
    issue('tm-e.3', { parent: 'tm-e', dependencies: [child('tm-e.3', 'tm-e'), blocks('tm-e.3', 'tm-e.2')] }),
    issue('tm-x', { status: 'blocked' }),
    issue('tm-d', { defer_until: '2026-11-01T00:00:00Z' }),
    issue('tm-old', { updated_at: '2026-09-01T00:00:00Z' }),
  ]);
}

describe('the shapes bd accepts', () => {
  it('ids, memory keys and labels', () => {
    expect(isIssueId('tm-3gs.12')).toBe(true);
    for (const prefixed of ['al_rasikhoon-hk0', 'beads-explorer-3gs.2']) expect(isIssueId(prefixed)).toBe(true);
    for (const bad of ['', 'tm-a; rm', '../x', '-rf', 'TM-A', '_x-a', 'tm-', 'tm-a/b']) expect(isIssueId(bad)).toBe(false);
    expect(isMemoryKey('auth-jwt')).toBe(true);
    expect(isMemoryKey('schema_version')).toBe(false);
    expect(isLabel('phase-2')).toBe(true);
    expect(isLabel('a,b')).toBe(false);
  });
});

describe('normalizing bd issues', () => {
  it('fills missing arrays and keeps every issue by id', () => {
    const { issues, byId } = normalizeIssues([{ id: 'tm-a', title: 'A', status: 'open', priority: 1 }]);
    expect(issues[0].labels).toEqual([]);
    expect(issues[0].dependencies).toEqual([]);
    expect(byId.get('tm-a')?.title).toBe('A');
  });
});

describe('ready and blocked, as bd ready decides', () => {
  it('an open issue whose only blocker is closed is ready', () => {
    const m = fixture();
    expect(isReady(m.byId.get('tm-e.2')!, m.byId, NOW)).toBe(true);
    expect(blockersOf(m.byId.get('tm-e.2')!, m.byId)).toEqual([]);
  });

  it('an open issue with an open blocker is blocked, not ready', () => {
    const m = fixture();
    const it3 = m.byId.get('tm-e.3')!;
    expect(isReady(it3, m.byId, NOW)).toBe(false);
    expect(isBlocked(it3, m.byId)).toBe(true);
    expect(blockersOf(it3, m.byId).map((b) => b.id)).toEqual(['tm-e.2']);
  });

  it('a parent link never blocks its child', () => {
    const m = fixture();
    expect(blockersOf(m.byId.get('tm-e.1')!, m.byId)).toEqual([]);
  });

  it('a child of a blocked parent is blocked too, as bd ready decides', () => {
    const m = normalizeIssues([
      issue('tm-b'),
      issue('tm-p', { dependencies: [blocks('tm-p', 'tm-b')] }),
      issue('tm-p.1', { parent: 'tm-p', dependencies: [child('tm-p.1', 'tm-p')] }),
      issue('tm-p.1.1', { parent: 'tm-p.1', dependencies: [child('tm-p.1.1', 'tm-p.1')] }),
    ]);
    for (const id of ['tm-p', 'tm-p.1', 'tm-p.1.1']) {
      expect(isReady(m.byId.get(id)!, m.byId, NOW)).toBe(false);
      expect(isBlocked(m.byId.get(id)!, m.byId)).toBe(true);
    }
    expect(isReady(m.byId.get('tm-b')!, m.byId, NOW)).toBe(true);
  });

  it('a stored blocked status counts as blocked', () => {
    const m = fixture();
    expect(isBlocked(m.byId.get('tm-x')!, m.byId)).toBe(true);
  });

  it('a deferred issue is not ready until its date', () => {
    const m = fixture();
    expect(isReady(m.byId.get('tm-d')!, m.byId, NOW)).toBe(false);
    expect(isReady(m.byId.get('tm-d')!, m.byId, new Date('2026-11-02T00:00:00Z'))).toBe(true);
  });
});

describe('epics', () => {
  it('progress counts closed children over all children', () => {
    const m = fixture();
    expect(childrenOf('tm-e', m.issues).map((c) => c.id)).toEqual(['tm-e.1', 'tm-e.2', 'tm-e.3']);
    expect(epicProgress('tm-e', m.issues)).toEqual({ total: 3, closed: 1, percent: 33 });
  });

  it('an epic without children has no progress to show', () => {
    expect(epicProgress('tm-none', fixture().issues)).toEqual({ total: 0, closed: 0, percent: 0 });
  });
});

describe('the dependency graph', () => {
  it('draws blocks edges from the blocker to the blocked issue, and parent edges when asked', () => {
    const m = fixture();
    const g = buildGraph(m, { includeParents: true, includeClosed: true });
    expect(g.edges).toContainEqual({ id: 'blocks:tm-e.1->tm-e.2', source: 'tm-e.1', target: 'tm-e.2', kind: 'blocks' });
    expect(g.edges).toContainEqual({ id: 'parent:tm-e->tm-e.2', source: 'tm-e', target: 'tm-e.2', kind: 'parent' });
    expect(buildGraph(m, { includeParents: false }).edges.every((e) => e.kind === 'blocks')).toBe(true);
  });

  it('hides closed issues unless asked, and a focus keeps only neighbours within the depth', () => {
    const m = fixture();
    expect(buildGraph(m, { includeParents: true }).nodes.map((n) => n.id)).not.toContain('tm-e.1');
    const focused = buildGraph(m, { includeParents: false, includeClosed: true, focus: 'tm-e.3', depth: 1 });
    expect(focused.nodes.map((n) => n.id).sort()).toEqual(['tm-e.2', 'tm-e.3']);
  });

  it('leaves out edges to issues it does not show', () => {
    const m = normalizeIssues([issue('tm-a', { dependencies: [blocks('tm-a', 'tm-gone')] })]);
    expect(buildGraph(m, { includeParents: true }).edges).toEqual([]);
  });
});

describe('search', () => {
  it('matches id, title, description, notes and labels, ignoring case', () => {
    const it1 = normalizeIssues([issue('tm-q', { title: 'Lesson Q&A', notes: 'Telegram alert', labels: ['lms'] })]).issues[0];
    for (const q of ['TM-Q', 'q&a', 'telegram', 'lms']) expect(matchesQuery(it1, q)).toBe(true);
    expect(matchesQuery(it1, 'stripe')).toBe(false);
    expect(matchesQuery(it1, '')).toBe(true);
  });
});

describe('insights', () => {
  it('counts statuses and finds stale and ready issues', () => {
    const m = fixture();
    const i = insights(m, NOW, { owner: 'Hassan' });
    expect(i.byStatus).toEqual({ open: 5, closed: 1, blocked: 1 });
    expect(i.stale.map((s) => s.id)).toEqual(['tm-old']);
    expect(i.ready.map((r) => r.id)).toContain('tm-e.2');
    expect(i.ready.map((r) => r.id)).not.toContain('tm-e.3');
  });
});

describe('the AI suggestion block', () => {
  it('reads the allowed fields from the last beads-update block', () => {
    const text = 'Looks done.\n\n```beads-update\n{"status":"closed","priority":3,"notes":"Done","rm":"-rf"}\n```';
    expect(extractUpdateBlock(text)).toEqual({ status: 'closed', priority: 3, appendNotes: 'Done' });
  });

  it('ignores malformed JSON, unknown statuses and a reply without a block', () => {
    expect(extractUpdateBlock('```beads-update\n{not json}\n```')).toBeNull();
    expect(extractUpdateBlock('```beads-update\n{"status":"done"}\n```')).toBeNull();
    expect(extractUpdateBlock('no block here')).toBeNull();
  });
});
