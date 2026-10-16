import { describe, expect, it } from 'vitest';
import { BadRequest, bdArgs, validateCreate, validateId, validateIds, validateKey, validatePatch } from '../lib/bd.mjs';

describe('the bd arguments for each action', () => {
  it('reads with --json, and reads one issue without bd show', () => {
    expect(bdArgs.list()).toEqual(['list', '--all', '--json', '--limit', '0']);
    expect(bdArgs.get(['tm-3gs.12'])).toEqual(['list', '--all', '--json', '--limit', '0', '--id=tm-3gs.12']);
    expect(bdArgs.comments('tm-3gs.12')).toEqual(['comments', 'tm-3gs.12', '--json']);
    expect(bdArgs.memories()).toEqual(['memories', '--json']);
    const everyRead = [bdArgs.list(), bdArgs.get(['tm-a']), bdArgs.comments('tm-a'), bdArgs.memories()];
    expect(everyRead.some((a) => a[0] === 'show')).toBe(false);
  });

  it('binds every text to its flag, so text that looks like a flag stays text', () => {
    expect(bdArgs.update('tm-a', { status: 'in_progress', priority: 1, description: '--status closed; rm -rf /' })).toEqual([
      'update', 'tm-a', '--status=in_progress', '--priority=1', '--description=--status closed; rm -rf /',
    ]);
    expect(bdArgs.close('tm-a', '-r x')).toEqual(['close', 'tm-a', '--reason=-r x']);
    expect(bdArgs.update('tm-a', { appendNotes: '- a bullet' })).toEqual(['update', 'tm-a', '--append-notes=- a bullet']);
  });

  it('passes positional text after --', () => {
    expect(bdArgs.addComment('tm-a', '-f/etc/passwd')).toEqual(['comments', 'add', 'tm-a', '--', '-f/etc/passwd']);
    expect(bdArgs.remember('auth-jwt', '- starts with a bullet')).toEqual(['remember', '--key=auth-jwt', '--', '- starts with a bullet']);
    expect(bdArgs.forget('auth-jwt')).toEqual(['forget', 'auth-jwt']);
  });

  it('changes several issues in one call', () => {
    expect(bdArgs.update(['tm-a', 'tm-b'], { priority: 3 })).toEqual(['update', 'tm-a', 'tm-b', '--priority=3']);
    expect(bdArgs.close(['tm-a', 'tm-b'], 'done')).toEqual(['close', 'tm-a', 'tm-b', '--reason=done']);
    expect(bdArgs.close(['tm-a'], 'done', true)).toEqual(['close', 'tm-a', '--reason=done', '--force']);
  });

  it('builds labels, blocks dependencies, reopen, create and sync', () => {
    expect(bdArgs.update('tm-a', { addLabels: ['lms'], removeLabels: ['old'] })).toEqual(['update', 'tm-a', '--add-label=lms', '--remove-label=old']);
    expect(bdArgs.depAdd('tm-a', 'tm-b')).toEqual(['dep', 'add', 'tm-a', 'tm-b', '--type=blocks']);
    expect(bdArgs.depRemove('tm-a', 'tm-b')).toEqual(['dep', 'remove', 'tm-a', 'tm-b']);
    expect(bdArgs.reopen('tm-a')).toEqual(['reopen', 'tm-a']);
    expect(bdArgs.create({ title: 'New', type: 'bug', priority: 1, description: 'D', parent: 'tm-a' })).toEqual([
      'create', '--json', '--title=New', '--type=bug', '--priority=1', '--description=D', '--parent=tm-a',
    ]);
    expect(bdArgs.sync()).toEqual(['dolt', 'push']);
  });
});

describe('what the server refuses', () => {
  it('ids and memory keys outside bd shapes', () => {
    expect(validateId('tm-3gs.12')).toBe('tm-3gs.12');
    expect(validateId('al_rasikhoon-hk0')).toBe('al_rasikhoon-hk0');
    for (const bad of ['', 'tm-a; rm', '../x', '-rf', 'TM-A']) expect(() => validateId(bad)).toThrow(BadRequest);
    expect(validateIds(['tm-a', 'tm-b'])).toEqual(['tm-a', 'tm-b']);
    expect(() => validateIds([])).toThrow(BadRequest);
    expect(validateKey('auth-jwt')).toBe('auth-jwt');
    for (const bad of ['', 'schema_version', '-x', 'a b']) expect(() => validateKey(bad)).toThrow(BadRequest);
  });

  it('patches with unknown fields, statuses or priorities, or text that is too long', () => {
    expect(validatePatch({ status: 'pinned', priority: 0, notes: 'ok', expectedUpdatedAt: '2026-10-15T00:00:00Z' }))
      .toEqual({ patch: { status: 'pinned', priority: 0, notes: 'ok' }, expectedUpdatedAt: '2026-10-15T00:00:00Z' });
    expect(() => validatePatch({ status: 'done' })).toThrow(BadRequest);
    expect(() => validatePatch({ status: 'closed' })).toThrow(/close action/);
    expect(() => validatePatch({ priority: 7 })).toThrow(BadRequest);
    expect(() => validatePatch({ owner: 'x' })).toThrow(BadRequest);
    expect(() => validatePatch({ notes: 'x'.repeat(20001) })).toThrow(BadRequest);
    expect(() => validatePatch({})).toThrow(BadRequest);
    expect(() => validatePatch({ addLabels: ['ok', 'a,b'] })).toThrow(BadRequest);
  });

  it('a new issue without a title or with an unknown type', () => {
    expect(validateCreate({ title: 'T', type: 'spike', priority: 2 })).toEqual({ title: 'T', type: 'spike', priority: 2 });
    expect(() => validateCreate({ title: ' ', type: 'task' })).toThrow(BadRequest);
    expect(() => validateCreate({ title: 'T', type: 'saga' })).toThrow(BadRequest);
  });
});
