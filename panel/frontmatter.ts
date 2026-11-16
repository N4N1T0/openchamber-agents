// Surgical reader/writer for the YAML frontmatter of an OpenCode agent file.
//
// It only understands the top-level scalar keys the panel edits
// (description, model, mode, temperature, disable, …) and the `permissions`
// list, which has its own reader. Anything else — `tools:` maps, comments, key
// order — is carried through
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

const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const indentOf = (line: string): number => line.length - line.replace(/^[ \t]+/, '').length;

/** One rule of the `permissions:` list. */
export type PermissionRuleEntry = { action: string; resource: string; effect: string };

const LIST_FIELD = /^([A-Za-z_]+)\s*:\s*(.*)$/;

/**
 * The rules of a `permissions:` list, as OpenChamber's Agents page writes them:
 *
 *   permissions:
 *     - action: "*"
 *       resource: "*"
 *       effect: deny
 *
 * Returns `[]` when the file has no `permissions` key, and `null` when the block
 * is shaped differently (a comment, an extra field, a map, a missing field). A
 * `null` block is carried through untouched.
 */
export const readPermissionList = (file: AgentFile): PermissionRuleEntry[] | null => {
  const entry = file.entries.find((item) => item.key === 'permissions');
  if (!entry) return [];
  if (entry.kind !== 'opaque') return null;

  const body = entry.lines.slice(1);
  if (body.length === 0) return null;
  const itemIndent = indentOf(body[0]!);
  const items: Record<string, string>[] = [];
  let fieldIndent = -1;

  for (const line of body) {
    const text = line.trim();
    if (text.startsWith('#')) return null;
    const indent = indentOf(line);
    if (indent === itemIndent) {
      if (!text.startsWith('- ')) return null;
      items.push({});
      fieldIndent = -1;
      const first = LIST_FIELD.exec(text.slice(2).trim());
      if (!first) return null;
      items[items.length - 1]![first[1]!] = unquote(first[2]!.trim());
      continue;
    }
    const current = items[items.length - 1];
    if (indent < itemIndent || !current) return null;
    if (fieldIndent === -1) fieldIndent = indent;
    if (indent !== fieldIndent) return null;
    const field = LIST_FIELD.exec(text);
    if (!field) return null;
    current[field[1]!] = unquote(field[2]!.trim());
  }

  const rules: PermissionRuleEntry[] = [];
  for (const item of items) {
    const keys = Object.keys(item).sort().join(',');
    if (keys !== 'action,effect,resource') return null;
    const { action, resource, effect } = item as Record<string, string>;
    if (!action || !resource || !effect) return null;
    rules.push({ action, resource, effect });
  }
  return rules;
};

const yamlValue = (value: string): string =>
  PLAIN_KEY.test(value) ? value : `'${value.replaceAll("'", "''")}'`;

/** The `permissions:` block lines for `rules`. Empty rules mean no block at all. */
export const permissionListLines = (rules: PermissionRuleEntry[]): string[] => {
  const out = ['permissions:'];
  for (const rule of rules) {
    out.push(`  - action: ${yamlValue(rule.action)}`);
    out.push(`    resource: ${yamlValue(rule.resource)}`);
    out.push(`    effect: ${yamlValue(rule.effect)}`);
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
