import { describe, expect, test } from 'bun:test';
import {
  parseAgentFile,
  permissionListLines,
  readField,
  readPermissionList,
  untouchedKeys,
  writeAgentFile,
} from './frontmatter';

const OWNED = ['description', 'model', 'mode', 'temperature', 'disable'];

/** A real agent file: nested permissions, a folded description, a long body. */
const NESTED = `---
description: Redacta el borrador de un artículo SEO a partir del brief del
  researcher. Entrega texto completo, nunca publica.
model: claude-code/claude-opus-5
mode: subagent
permissions:
  - action: "*"
    resource: "*"
    effect: deny
  - action: read
    resource: "*"
    effect: allow
---

# Job

Write the draft.
`;

/** Shapes the panel does not edit but must not disturb. */
const TRICKY = `---
# which model to use
model: "anthropic/claude-opus-5"
mode: subagent
description: >
  folded block
  scalar text
tools:
  write: false
  bash: true
prompt: |
  line one
  line two
color: '#ff0000'
---

Body text.
`;

/** Rules with a pattern under bash, and a hidden rule the panel keeps as written. */
const RULES = `---
description: Reviews code.
permissions:
  - action: "*"
    resource: "*"
    effect: ask
  - action: bash
    resource: "*"
    effect: deny
  - action: bash
    resource: "git status*"
    effect: allow
  - action: read
    resource: "*.env"
    effect: ask
tools:
  write: false
---

Review.
`;

describe('reading', () => {
  test('a folded plain scalar becomes one line', () => {
    const file = parseAgentFile(NESTED);
    expect(readField(file, 'description')).toBe(
      'Redacta el borrador de un artículo SEO a partir del brief del researcher. Entrega texto completo, nunca publica.',
    );
    expect(readField(file, 'model')).toBe('claude-code/claude-opus-5');
    expect(readField(file, 'mode')).toBe('subagent');
  });

  test('quotes are stripped, `>` folds, `|` keeps the breaks', () => {
    const file = parseAgentFile(TRICKY);
    expect(readField(file, 'model')).toBe('anthropic/claude-opus-5');
    expect(readField(file, 'description')).toBe('folded block scalar text');
    expect(readField(file, 'prompt')).toBe('line one\nline two');
    expect(readField(file, 'color')).toBe('#ff0000');
  });

  test('a nested block is reported as a key the panel does not own', () => {
    expect(untouchedKeys(parseAgentFile(NESTED), OWNED)).toEqual(['permissions']);
    expect(untouchedKeys(parseAgentFile(TRICKY), OWNED)).toEqual(['tools', 'prompt', 'color']);
  });

  test('a file without frontmatter is all body', () => {
    const file = parseAgentFile('Just a prompt.\n');
    expect(file.hadFrontmatter).toBe(false);
    expect(file.body.trim()).toBe('Just a prompt.');
  });

  test('an unterminated frontmatter marker is not frontmatter', () => {
    const file = parseAgentFile('---\ndescription: x\n');
    expect(file.hadFrontmatter).toBe(false);
    expect(readField(file, 'description')).toBe(null);
  });
});

describe('writing', () => {
  for (const [name, original] of [
    ['nested', NESTED],
    ['tricky', TRICKY],
  ] as const) {
    test(`${name}: rewriting with no change keeps the file`, () => {
      const file = parseAgentFile(original);
      expect(writeAgentFile(file, {}, file.body).trim()).toBe(original.trim());
    });

    test(`${name}: off and on again returns to the same file`, () => {
      const file = parseAgentFile(original);
      const off = parseAgentFile(writeAgentFile(file, { disable: 'true' }, file.body));
      expect(readField(off, 'disable')).toBe('true');
      expect(writeAgentFile(off, { disable: null }, off.body).trim()).toBe(original.trim());
    });
  }

  test('editing one key leaves every other line alone', () => {
    const file = parseAgentFile(NESTED);
    const next = writeAgentFile(file, { description: "Now with: a colon and 'quotes'." }, file.body);
    expect(next).toContain("description: 'Now with: a colon and ''quotes''.'");
    expect(next).toContain('    effect: deny');
    expect(next).toContain('  - action: read');
    const reparsed = parseAgentFile(next);
    expect(readField(reparsed, 'description')).toBe("Now with: a colon and 'quotes'.");
    expect(readField(reparsed, 'model')).toBe(readField(file, 'model'));
    expect(untouchedKeys(reparsed, OWNED)).toEqual(['permissions']);
  });

  test('replacing a folded scalar leaves no orphan continuation lines', () => {
    const file = parseAgentFile(NESTED);
    const next = writeAgentFile(file, { description: 'Short now.' }, file.body);
    expect(next).not.toContain('researcher. Entrega');
    expect(next.split('\n').filter((line) => line.startsWith('description'))).toHaveLength(1);
  });

  test('a comment, a nested map and a block scalar survive a write', () => {
    const file = parseAgentFile(TRICKY);
    const next = writeAgentFile(file, { disable: 'true', model: 'z/mini' }, file.body);
    expect(next).toContain('# which model to use');
    expect(next).toContain("model: 'z/mini'");
    expect(next).toContain('  write: false');
    expect(next).toContain('prompt: |');
    expect(next).toContain('  line two');
    expect(next).toContain('disable: true');
  });

  test('booleans and numbers are written bare, text is quoted', () => {
    const fresh = writeAgentFile({ entries: [], hadFrontmatter: false, body: '' }, {
      description: 'Reviews a diff.',
      mode: 'subagent',
      temperature: '0.2',
      disable: null,
    }, '# Job\n\nReview.\n');
    expect(fresh).toBe(
      "---\ndescription: 'Reviews a diff.'\nmode: 'subagent'\ntemperature: 0.2\n---\n\n# Job\n\nReview.\n",
    );
  });

  test('a value with newlines becomes a block scalar and reads back', () => {
    const written = writeAgentFile({ entries: [], hadFrontmatter: false, body: '' }, {
      description: 'first\nsecond',
    }, '');
    expect(written).toContain('description: |-');
    expect(readField(parseAgentFile(written), 'description')).toBe('first\nsecond');
  });

  test('CRLF input is written back with plain newlines', () => {
    const file = parseAgentFile('---\r\nmode: subagent\r\n---\r\n\r\nBody.\r\n');
    expect(readField(file, 'mode')).toBe('subagent');
    expect(writeAgentFile(file, {}, file.body)).not.toContain('\r');
  });
});

describe('permissions list', () => {
  test('the rules read in file order, with their resources', () => {
    expect(readPermissionList(parseAgentFile(RULES))).toEqual([
      { action: '*', resource: '*', effect: 'ask' },
      { action: 'bash', resource: '*', effect: 'deny' },
      { action: 'bash', resource: 'git status*', effect: 'allow' },
      { action: 'read', resource: '*.env', effect: 'ask' },
    ]);
  });

  test('no permissions key reads as no rules', () => {
    expect(readPermissionList(parseAgentFile('---\nmode: subagent\n---\n'))).toEqual([]);
  });

  test('a block of another shape is kept as written', () => {
    const map = '---\npermissions:\n  edit: deny\n---\n';
    const extra = '---\npermissions:\n  - action: read\n    resource: "*"\n    effect: allow\n    note: x\n---\n';
    const comment = '---\npermissions:\n  # keep\n  - action: read\n    resource: "*"\n    effect: allow\n---\n';
    const scalar = '---\npermissions: allow\n---\n';
    for (const text of [map, extra, comment, scalar]) {
      expect(readPermissionList(parseAgentFile(text))).toBe(null);
    }
  });

  test('rewriting the rules reads back the same rules and keeps the other keys', () => {
    const file = parseAgentFile(RULES);
    const rules = readPermissionList(file)!;
    const next = writeAgentFile(file, { permissions: permissionListLines(rules) }, file.body);
    expect(readPermissionList(parseAgentFile(next))).toEqual(rules);
    expect(next).toContain('tools:\n  write: false');
    expect(next.trim().endsWith('Review.')).toBe(true);
  });

  test('an edited rule changes the block and nothing else', () => {
    const file = parseAgentFile(RULES);
    const rules = readPermissionList(file)!;
    rules[0] = { action: '*', resource: '*', effect: 'deny' };
    const next = writeAgentFile(file, { permissions: permissionListLines(rules) }, file.body);
    expect(next).toContain('effect: deny');
    expect(next).toContain('tools:\n  write: false');
    expect(next).toContain('description: Reviews code.');
    expect(readPermissionList(parseAgentFile(next))).toEqual(rules);
  });

  test('a pattern with quotes and a star round trips', () => {
    const rules = [{ action: 'bash', resource: "npm run it's*", effect: 'allow' }];
    const written = writeAgentFile({ entries: [], hadFrontmatter: false, body: '' }, {
      permissions: permissionListLines(rules),
    }, '');
    expect(written).toContain("    resource: 'npm run it''s*'");
    expect(readPermissionList(parseAgentFile(written))).toEqual(rules);
  });

  test('removing the block drops the key', () => {
    const file = parseAgentFile(RULES);
    const next = writeAgentFile(file, { permissions: null }, file.body);
    expect(next).not.toContain('permissions');
    expect(readPermissionList(parseAgentFile(next))).toEqual([]);
  });
});
