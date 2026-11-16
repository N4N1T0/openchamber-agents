// Surgical reader/writer for the YAML frontmatter of an OpenCode agent file.
//
// It only understands the top-level scalar keys the panel edits
// (description, model, mode, temperature, disable, …). Anything else —
// `permission:` blocks, `tools:` maps, comments, key order — is carried through
// untouched, so saving never loses a field this panel does not know about.

type Entry = {
  key: string | null; // null for a comment or blank line we just carry over
  lines: string[];
  kind: 'scalar' | 'opaque';
  value: string;
};

export type AgentFile = {
  entries: Entry[];
  hadFrontmatter: boolean;
  body: string;
};

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:(.*)$/;

const unquote = (raw: string): string => {
  const text = raw.trim();
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replaceAll("''", "'");
  }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text
      .slice(1, -1)
      .replace(/\\(["\\/nrt])/g, (_, char: string) => {
        if (char === 'n') return '\n';
        if (char === 'r') return '\r';
        if (char === 't') return '\t';
        return char;
      });
  }
  return text;
};

const indented = (line: string): boolean => /^[ \t]/.test(line) && line.trim() !== '';

export const parseAgentFile = (text: string): AgentFile => {
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { entries: [], hadFrontmatter: false, body: normalized };
  }
  let close = -1;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line === '---' || line === '...') {
      close = index;
      break;
    }
  }
  if (close === -1) return { entries: [], hadFrontmatter: false, body: normalized };

  const frontmatter = lines.slice(1, close);
  const body = lines.slice(close + 1).join('\n');
  const entries: Entry[] = [];

  let index = 0;
  while (index < frontmatter.length) {
    const line = frontmatter[index]!;
    const match = KEY_LINE.exec(line);
    if (!match || indented(line)) {
      entries.push({ key: null, lines: [line], kind: 'opaque', value: '' });
      index += 1;
      continue;
    }
    const key = match[1]!;
    const head = (match[2] ?? '').trim();
    const taken = [line];
    index += 1;
    while (index < frontmatter.length && indented(frontmatter[index]!)) {
      taken.push(frontmatter[index]!);
      index += 1;
    }
    const continuation = taken.slice(1);
    const blockScalar = head.startsWith('|') || head.startsWith('>');
    if (head === '' || blockScalar) {
      if (continuation.length === 0 && !blockScalar) {
        entries.push({ key, lines: taken, kind: 'scalar', value: '' });
      } else if (blockScalar) {
        const indent = Math.min(
          ...continuation.map((entry) => entry.length - entry.replace(/^[ \t]+/, '').length),
        );
        const kept = continuation.map((entry) => entry.slice(indent));
        // `|` keeps the line breaks, `>` folds them into spaces.
        const joined = head.startsWith('>')
          ? kept.map((entry) => entry.trim()).join(' ').trim()
          : kept.join('\n');
        entries.push({ key, lines: taken, kind: 'scalar', value: joined.replace(/\n+$/, '') });
      } else {
        entries.push({ key, lines: taken, kind: 'opaque', value: '' });
      }
      continue;
    }
    // A plain scalar, possibly folded over the following indented lines.
    const folded = [head, ...continuation.map((entry) => entry.trim())].join(' ').trim();
    entries.push({ key, lines: taken, kind: 'scalar', value: unquote(folded) });
  }

  return { entries, hadFrontmatter: true, body };
};

export const readField = (file: AgentFile, key: string): string | null => {
  const entry = file.entries.find((item) => item.key === key && item.kind === 'scalar');
  return entry ? entry.value : null;
};

export const hasOpaqueField = (file: AgentFile, key: string): boolean =>
  file.entries.some((item) => item.key === key && item.kind === 'opaque');

/** Top-level keys the panel does not edit, so the editor can say what it keeps. */
export const untouchedKeys = (file: AgentFile, known: string[]): string[] =>
  file.entries
    .map((entry) => entry.key)
    .filter((key): key is string => Boolean(key) && !known.includes(key!));

const BARE = /^(?:true|false|null|-?\d+(?:\.\d+)?)$/;

const formatValue = (key: string, value: string): string[] => {
  if (BARE.test(value)) return [`${key}: ${value}`];
  if (value === '') return [`${key}: ''`];
  if (value.includes('\n')) {
    const lines = value.split('\n').map((line) => (line === '' ? '' : `  ${line}`));
    return [`${key}: |-`, ...lines];
  }
  return [`${key}: '${value.replaceAll("'", "''")}'`];
};

/** One permission rule: `tool: allow`, or `tool:` with a map of patterns. */
export type PermissionPattern = { pattern: string; value: string };
export type PermissionRule =
  | { kind: 'value'; tool: string; value: string }
  | { kind: 'patterns'; tool: string; patterns: PermissionPattern[] };

// `"key": value` or `key: value`, the key quoted or plain (no colon, no `#`).
const PAIR = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^"'#\s][^:#]*?)\s*:(.*)$/;
const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;

const indentOf = (line: string): number => line.length - line.replace(/^[ \t]+/, '').length;

/**
 * The rules of a `permission:` map, in the shape OpenCode writes it:
 *
 *   permission:
 *     edit: deny
 *     bash:
 *       "*": ask
 *       "git status*": allow
 *
 * Returns `[]` when the file has no `permission` key, and `null` when the block
 * is something the editor does not model (a list, a comment, a deeper nest, a
 * single value). A `null` block is carried through untouched.
 */
export const readPermissions = (file: AgentFile): PermissionRule[] | null => {
  const entry = file.entries.find((item) => item.key === 'permission');
  if (!entry) return [];
  if (entry.kind !== 'opaque') return null;

  const body = entry.lines.slice(1);
  if (body.length === 0) return null;
  if (body.some((line) => /^\s*(#|-(\s|$))/.test(line))) return null;

  const childIndent = indentOf(body[0]!);
  const rules: PermissionRule[] = [];
  const seen = new Set<string>();
  let index = 0;

  while (index < body.length) {
    const line = body[index]!;
    if (indentOf(line) !== childIndent) return null;
    const pair = PAIR.exec(line.trim());
    if (!pair) return null;
    const tool = unquote(pair[1]!);
    const head = pair[2]!.trim();
    if (tool === '' || seen.has(tool) || head.includes(' #')) return null;
    seen.add(tool);
    index += 1;

    if (head !== '') {
      rules.push({ kind: 'value', tool, value: unquote(head) });
      continue;
    }

    const patterns: PermissionPattern[] = [];
    let patternIndent = -1;
    while (index < body.length && indentOf(body[index]!) > childIndent) {
      const sub = body[index]!;
      if (patternIndent === -1) patternIndent = indentOf(sub);
      if (indentOf(sub) !== patternIndent) return null;
      const match = PAIR.exec(sub.trim());
      if (!match || match[2]!.trim() === '') return null;
      patterns.push({ pattern: unquote(match[1]!), value: unquote(match[2]!.trim()) });
      index += 1;
    }
    if (patterns.length === 0) return null;
    rules.push({ kind: 'patterns', tool, patterns });
  }

  return rules;
};

const yamlKey = (key: string): string =>
  PLAIN_KEY.test(key) ? key : `'${key.replaceAll("'", "''")}'`;

const yamlValue = (value: string): string =>
  PLAIN_KEY.test(value) ? value : `'${value.replaceAll("'", "''")}'`;

/** The `permission:` block lines for `rules`. Empty rules mean no block at all. */
export const permissionLines = (rules: PermissionRule[]): string[] => {
  const out = ['permission:'];
  for (const rule of rules) {
    if (rule.kind === 'value') {
      out.push(`  ${yamlKey(rule.tool)}: ${yamlValue(rule.value)}`);
      continue;
    }
    out.push(`  ${yamlKey(rule.tool)}:`);
    for (const { pattern, value } of rule.patterns) {
      out.push(`    ${yamlKey(pattern)}: ${yamlValue(value)}`);
    }
  }
  return out;
};

/**
 * Rewrite the file with `updates` applied: a string replaces or adds the key,
 * a string[] replaces it with those raw lines (used for `permission`), `null`
 * removes it. Every other line of the frontmatter is kept as written.
 */
export const writeAgentFile = (
  file: AgentFile,
  updates: Record<string, string | string[] | null>,
  body: string,
): string => {
  const pending = new Set(Object.keys(updates));
  const out: string[] = [];

  const emit = (key: string, next: string | string[]): void => {
    out.push(...(Array.isArray(next) ? next : formatValue(key, next)));
  };

  for (const entry of file.entries) {
    if (entry.key && pending.has(entry.key)) {
      pending.delete(entry.key);
      const next = updates[entry.key]!;
      if (next === null) continue; // drop the key
      if (entry.kind === 'opaque' && !Array.isArray(next)) {
        out.push(...entry.lines); // never rewrite a nested block unless asked
        continue;
      }
      emit(entry.key, next);
      continue;
    }
    out.push(...entry.lines);
  }

  for (const key of pending) {
    const next = updates[key];
    if (next === null || next === undefined) continue;
    emit(key, next);
  }

  const trimmedBody = body.replace(/\r\n?/g, '\n').trim();
  const tail = trimmedBody === '' ? '\n' : `\n${trimmedBody}\n`;
  return `---\n${out.join('\n')}\n---\n${tail}`;
};
