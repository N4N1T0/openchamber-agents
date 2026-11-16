// The tool permissions of an agent, in the list form OpenChamber's Agents page
// writes into an agent file:
//
//   permissions:
//     - action: "*"
//       resource: "*"
//       effect: deny
//     - action: bash
//       resource: "git status*"
//       effect: allow
//
// A rule whose resource is `*` sets its action (`*` with `*` is the default for
// every tool). Any other resource is a pattern under its action. Later rules
// win, so a pattern placed after its action's rule overrides it.

export type PermissionEntry = { action: string; resource: string; effect: string };
export type Effect = 'allow' | 'ask' | 'deny';

const ANY = '*';

/** Tools the Agents page lists, in its order. */
export const BUILTIN_TOOLS = [
  'shell',
  'edit',
  'read',
  'glob',
  'grep',
  'patch',
  'webfetch',
  'websearch',
  'skill',
  'subagent',
  'question',
  'external_directory',
];

/** The OpenChamber tools an agent can be given. */
export const OPENCHAMBER_TOOLS = [
  'openchamber',
  'openchamber_schedule',
  'openchamber_web',
  'openchamber_memory',
  'openchamber_knowledge',
  'openchamber_notify',
  'openchamber_usage',
  'openchamber_render',
  'openchamber_image',
  'openchamber_secret',
];

/**
 * Legacy or internal names the Agents page does not list. Their rules are kept
 * in the file as written, so saving never drops a rule the panel cannot show.
 */
export const HIDDEN_TOOLS = new Set([
  'bash',
  'task',
  'write',
  'list',
  'lsp',
  'todowrite',
  'todoread',
  'multiedit',
  'doom_loop',
  'plan_enter',
  'plan_exit',
]);

/** The effect an action has on its own, or null when it inherits. */
export const effectOf = (entries: PermissionEntry[], action: string): string | null =>
  entries.find((entry) => entry.action === action && entry.resource === ANY)?.effect ?? null;

/** The pattern rules under an action, in file order. */
export const patternsOf = (entries: PermissionEntry[], action: string): PermissionEntry[] =>
  entries.filter((entry) => entry.action === action && entry.resource !== ANY);

/**
 * Set an action's own effect; `null` inherits (removes the rule). A new action
 * goes before the first rule of the same action, and the default goes first.
 */
export const setEffect = (
  entries: PermissionEntry[],
  action: string,
  effect: string | null,
): PermissionEntry[] => {
  const next = entries.map((entry) => ({ ...entry }));
  const at = next.findIndex((entry) => entry.action === action && entry.resource === ANY);
  if (effect === null) {
    if (at >= 0) next.splice(at, 1);
    return next;
  }
  const entry = { action, resource: ANY, effect };
  if (at >= 0) {
    next[at] = entry;
    return next;
  }
  if (action === ANY) {
    next.unshift(entry);
    return next;
  }
  const first = next.findIndex((item) => item.action === action);
  if (first >= 0) next.splice(first, 0, entry);
  else next.push(entry);
  return next;
};

/** Add or replace a pattern rule. A new pattern goes last, so it overrides its action. */
export const setPattern = (
  entries: PermissionEntry[],
  action: string,
  pattern: string,
  effect: string,
): PermissionEntry[] => {
  const next = entries.map((entry) => ({ ...entry }));
  const at = next.findIndex((entry) => entry.action === action && entry.resource === pattern);
  const entry = { action, resource: pattern, effect };
  if (at >= 0) next[at] = entry;
  else next.push(entry);
  return next;
};

export const removePattern = (
  entries: PermissionEntry[],
  action: string,
  pattern: string,
): PermissionEntry[] =>
  entries.filter((entry) => !(entry.action === action && entry.resource === pattern));

/** Actions in the file that the panel does not list by name (not hidden, not known). */
export const otherActions = (entries: PermissionEntry[], known: string[]): string[] => {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.action === ANY || HIDDEN_TOOLS.has(entry.action) || known.includes(entry.action)) continue;
    seen.add(entry.action);
  }
  return [...seen];
};
