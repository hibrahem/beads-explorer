import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findBeadsRoot, parseArgs } from '../bin/beads-explorer.mjs';

describe('the command line', () => {
  it('reads a repository path, port, owner and switches', () => {
    expect(parseArgs([])).toEqual({ path: null, port: null, owner: null, open: true, help: false, version: false });
    expect(parseArgs(['../repo', '--port', '4500', '--owner=Hassan', '--no-open'])).toMatchObject({ path: '../repo', port: 4500, owner: 'Hassan', open: false });
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--version']).version).toBe(true);
  });

  it('refuses a bad port, an unknown option or two paths', () => {
    expect(() => parseArgs(['--port', 'x'])).toThrow(/port/);
    expect(() => parseArgs(['--port'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--frobnicate'])).toThrow(/Unknown option/);
    expect(() => parseArgs(['a', 'b'])).toThrow(/one repository path/);
  });

  it('finds the nearest folder holding .beads from anywhere inside the repository', () => {
    const repo = mkdtempSync(join(tmpdir(), 'bx-repo-'));
    mkdirSync(join(repo, '.beads'));
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    expect(findBeadsRoot(join(repo, 'src', 'deep'))).toBe(repo);
    expect(findBeadsRoot(repo)).toBe(repo);
    expect(findBeadsRoot(mkdtempSync(join(tmpdir(), 'bx-none-')))).toBeNull();
  });
});
