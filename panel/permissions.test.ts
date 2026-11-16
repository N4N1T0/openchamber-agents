import { describe, expect, test } from 'bun:test';
import {
  effectOf,
  otherActions,
  patternsOf,
  removePattern,
  setEffect,
  setPattern,
  type PermissionEntry,
} from './permissions';

const BASE: PermissionEntry[] = [
  { action: '*', resource: '*', effect: 'deny' },
  { action: 'read', resource: '*', effect: 'allow' },
  { action: 'bash', resource: '*', effect: 'ask' },
  { action: 'bash', resource: 'git status*', effect: 'allow' },
  { action: 'write', resource: '*', effect: 'deny' },
];

describe('reading', () => {
  test('an action’s own effect ignores its patterns', () => {
    expect(effectOf(BASE, 'bash')).toBe('ask');
    expect(effectOf(BASE, 'edit')).toBe(null);
    expect(patternsOf(BASE, 'bash')).toEqual([{ action: 'bash', resource: 'git status*', effect: 'allow' }]);
  });

  test('other actions are the ones the panel does not list, hidden ones excluded', () => {
    expect(otherActions(BASE, ['read'])).toEqual([]);
    expect(otherActions([{ action: 'github_*', resource: '*', effect: 'ask' }], [])).toEqual(['github_*']);
  });
});

describe('editing', () => {
  test('setting an action replaces it in place', () => {
    const next = setEffect(BASE, 'read', 'ask');
    expect(next[1]).toEqual({ action: 'read', resource: '*', effect: 'ask' });
    expect(next).toHaveLength(BASE.length);
  });

  test('a new action with patterns goes before them; a new action alone goes last; the default goes first', () => {
    const onlyPattern = [
      { action: 'read', resource: '*.env', effect: 'ask' },
      { action: 'edit', resource: '*', effect: 'deny' },
    ];
    const before = setEffect(onlyPattern, 'read', 'allow');
    expect(before.map((entry) => entry.resource)).toEqual(['*', '*.env', '*']);
    expect(before[0]).toEqual({ action: 'read', resource: '*', effect: 'allow' });

    const last = setEffect(BASE, 'edit', 'allow');
    expect(last[last.length - 1]).toEqual({ action: 'edit', resource: '*', effect: 'allow' });

    const fresh = setEffect([{ action: 'read', resource: '*', effect: 'allow' }], '*', 'ask');
    expect(fresh[0]).toEqual({ action: '*', resource: '*', effect: 'ask' });
  });

  test('inherit removes the action’s own rule and keeps its patterns', () => {
    const next = setEffect(BASE, 'bash', null);
    expect(effectOf(next, 'bash')).toBe(null);
    expect(patternsOf(next, 'bash')).toHaveLength(1);
  });

  test('a pattern is added last, replaced in place, and removed', () => {
    const added = setPattern(BASE, 'read', '*.env', 'ask');
    expect(added[added.length - 1]).toEqual({ action: 'read', resource: '*.env', effect: 'ask' });
    const replaced = setPattern(BASE, 'bash', 'git status*', 'deny');
    expect(patternsOf(replaced, 'bash')[0]!.effect).toBe('deny');
    expect(replaced).toHaveLength(BASE.length);
    expect(patternsOf(removePattern(BASE, 'bash', 'git status*'), 'bash')).toEqual([]);
  });

  test('editing never mutates the input', () => {
    const copy = JSON.stringify(BASE);
    setEffect(BASE, 'read', 'deny');
    setPattern(BASE, 'read', 'x', 'deny');
    removePattern(BASE, 'bash', 'git status*');
    expect(JSON.stringify(BASE)).toBe(copy);
  });
});
