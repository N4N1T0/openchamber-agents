import { describe, expect, test } from 'bun:test';
import { parseAgentFile, readField, writeAgentFile } from './frontmatter';

const SKILL = `---
name: Git Release
description: Prepare a repository release
metadata:
  opencode/autoinvoke: false
---

Prepare the changelog.
`;

describe('disable-model-invocation on a skill', () => {
  test('turning it off writes the flag and keeps the rest of the file', () => {
    const file = parseAgentFile(SKILL);
    const text = writeAgentFile(file, { 'disable-model-invocation': 'true' }, file.body);
    const reparsed = parseAgentFile(text);

    expect(readField(reparsed, 'disable-model-invocation')).toBe('true');
    expect(readField(reparsed, 'name')).toBe('Git Release');
    expect(text).toContain('metadata:\n  opencode/autoinvoke: false');
    expect(reparsed.body.trim()).toBe('Prepare the changelog.');
  });

  test('turning it back on removes the flag', () => {
    const off = writeAgentFile(parseAgentFile(SKILL), { 'disable-model-invocation': 'true' }, '\nBody.\n');
    const on = writeAgentFile(parseAgentFile(off), { 'disable-model-invocation': null }, parseAgentFile(off).body);

    expect(readField(parseAgentFile(on), 'disable-model-invocation')).toBeNull();
    expect(on).not.toContain('disable-model-invocation');
  });
});
