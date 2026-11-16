import { connectHost, HostRequestError } from '@openchamber/sdk';
import {
  applyHostReady,
  mountBadge,
  mountBanner,
  mountButton,
  mountEmpty,
  mountSearchField,
  mountSelect,
  mountSpinner,
  mountSwitch,
  mountTabs,
  mountTextField,
} from '@openchamber/sdk/ui';
import {
  parseAgentFile,
  permissionListLines,
  readField,
  readPermissionList,
  untouchedKeys,
  writeAgentFile,
  type AgentFile,
  type PermissionRuleEntry,
} from './frontmatter';
import {
  BUILTIN_TOOLS,
  OPENCHAMBER_TOOLS,
  effectOf,
  otherActions,
  patternsOf,
  removePattern,
  setEffect,
  setPattern,
  type PermissionEntry,
} from './permissions';
import { collectModels, type ModelOption } from './models';

type Scope = 'global' | 'project';

type Agent = {
  scope: Scope;
  name: string;
  path: string;
  /** Which of OpenCode's two folder names holds it; the service needs it to delete. */
  folder: string;
  file: AgentFile;
  description: string;
  model: string;
  mode: string;
  disabled: boolean;
};

type Draft = {
  name: string;
  description: string;
  model: string;
  mode: string;
  temperature: string;
  prompt: string;
  /** The model is typed by hand instead of picked from the list. */
  customModel: boolean;
  /** The permission rules, or null when the block is kept as written. */
  permissions: PermissionRuleEntry[] | null;
};

/** Frontmatter keys this panel owns. Everything else is carried through. */
const OWNED = ['description', 'model', 'mode', 'temperature', 'disable'];
const CONFIG = '~/.config/opencode/opencode.json';
/** Sections the user opened, so a re-render keeps them open. */
const OPEN_SECTIONS = new Set<string>();

const GLOBAL_DIRS = [
  { dir: '~/.config/opencode/agents', folder: 'agents' },
  { dir: '~/.config/opencode/agent', folder: 'agent' },
];
const PROJECT_DIRS = [
  { dir: '.opencode/agents', folder: 'agents' },
  { dir: '.opencode/agent', folder: 'agent' },
];
const NAME_SHAPE = /^[a-z][a-z0-9-]*$/;
const PREFERENCES = '~/.config/openchamber/preferences.json';
const OTHER_MODEL = '__other__';
const INHERIT_MODEL = '__inherit__';

const host = connectHost();
const root = document.querySelector<HTMLElement>('#root')!;

let directory: string | null = null;
let sessionModel: string | null = null;
let scope: Scope = 'global';
let query = '';
let loading = false;
let loadError: string | null = null;
let agents: Agent[] = [];
/** MCP server names from the global OpenCode config; each one gets a rule row. */
let mcpServers: string[] = [];
let models: ModelOption[] = [];
let editing: { agent: Agent | null; draft: Draft; error: string | null } | null = null;
let started = false;

const ARROW_LEFT = 'M7.828 11H20v2H7.828l5.364 5.364-1.414 1.414L4 12l7.778-7.778 1.414 1.414z';

const iconSvg = (path: string, size = 14): SVGSVGElement => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  return svg;
};

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const failure = (error: unknown): string => {
  if (error instanceof HostRequestError) {
    if (error.code === 'NOT_GRANTED') return 'OpenChamber has not granted file access to this extension yet.';
    if (error.code === 'NO_DIRECTORY') return 'Open a project first.';
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
};

const dirsFor = (target: Scope) => (target === 'global' ? GLOBAL_DIRS : PROJECT_DIRS);

const toAgent = (
  target: Scope,
  name: string,
  path: string,
  folder: string,
  text: string,
): Agent => {
  const file = parseAgentFile(text);
  return {
    scope: target,
    name,
    path,
    folder,
    file,
    description: readField(file, 'description') ?? '',
    model: readField(file, 'model') ?? '',
    mode: readField(file, 'mode') ?? '',
    disabled: (readField(file, 'disable') ?? 'false').trim() === 'true',
  };
};

const readAgents = async (target: Scope): Promise<Agent[]> => {
  const found: Agent[] = [];
  const seen = new Set<string>();
  for (const { dir, folder } of dirsFor(target)) {
    let names: string[] = [];
    try {
      const info = await host.stat(dir);
      if (info.kind !== 'directory') continue;
      const listing = await host.listDir(dir);
      names = listing.entries
        .filter((entry) => entry.kind === 'file' && entry.name.toLowerCase().endsWith('.md'))
        .map((entry) => entry.name);
    } catch {
      continue; // a folder that is missing or unreadable simply has no agents
    }
    for (const fileName of names) {
      const name = fileName.slice(0, -3);
      if (seen.has(name)) continue;
      seen.add(name);
      const path = `${dir}/${fileName}`;
      try {
        const { content } = await host.readFile(path);
        found.push(toAgent(target, name, path, folder, content));
      } catch {
        // Unreadable file: leave it out rather than fail the whole list.
      }
    }
  }
  found.sort((left, right) => left.name.localeCompare(right.name));
  return found;
};

const readModels = async (used: string[]): Promise<ModelOption[]> => {
  let preferences: unknown = null;
  try {
    const { content } = await host.readFile(PREFERENCES);
    preferences = JSON.parse(content);
  } catch {
    // No readable preferences: the agents' own models still make a list.
  }
  return collectModels(preferences, sessionModel ? [...used, sessionModel] : used);
};

/** The MCP server names in the global config. Only that file is read; project configs are not. */
const readMcpServers = async (): Promise<string[]> => {
  try {
    const { content } = await host.readFile(CONFIG);
    const config: unknown = JSON.parse(content);
    const mcp = config && typeof config === 'object' ? (config as Record<string, unknown>).mcp : null;
    return mcp && typeof mcp === 'object' ? Object.keys(mcp).sort() : [];
  } catch {
    return []; // no readable config: there are simply no MCP rows
  }
};

const load = async (): Promise<void> => {
  if (scope === 'project' && !directory) {
    agents = [];
    loadError = null;
    render();
    return;
  }
  loading = true;
  loadError = null;
  render();
  try {
    agents = await readAgents(scope);
  } catch (error) {
    agents = [];
    loadError = failure(error);
  }
  models = await readModels(agents.map((agent) => agent.model));
  mcpServers = await readMcpServers();
  loading = false;
  render();
};

const targetDir = async (target: Scope): Promise<string> => {
  for (const { dir } of dirsFor(target)) {
    try {
      const info = await host.stat(dir);
      if (info.kind === 'directory') return dir;
    } catch {
      // keep looking
    }
  }
  return dirsFor(target)[0]!.dir;
};

/**
 * Turn an agent off or on from the list. `paint` moves the row to that state at
 * once and moves it back if the write fails, so the list is never rebuilt and
 * keeps its scroll position, the search text and the focused switch.
 */
const setEnabled = async (
  agent: Agent,
  enabled: boolean,
  paint: (enabled: boolean) => void,
): Promise<void> => {
  const text = writeAgentFile(agent.file, { disable: enabled ? null : 'true' }, agent.file.body);
  paint(enabled);
  try {
    await host.writeFile(agent.path, text);
  } catch (error) {
    paint(!enabled);
    await host.toast({ kind: 'error', message: failure(error) });
    return;
  }
  agent.file = parseAgentFile(text);
  agent.disabled = !enabled;
  await host.toast({
    kind: 'success',
    message: `${agent.name} is ${enabled ? 'on' : 'off'}. New sessions pick it up.`,
  });
};

/**
 * Delete an agent file. Only the service can remove a file, and it builds the
 * path from the scope, folder and name itself, so this call carries no path.
 */
const remove = async (agent: Agent): Promise<void> => {
  let answer: { status: number; body: string };
  try {
    answer = await host.serviceRequest({
      method: 'POST',
      path: '/delete',
      body: JSON.stringify({
        scope: agent.scope,
        folder: agent.folder,
        name: agent.name,
        directory: agent.scope === 'project' ? directory : undefined,
      }),
    });
  } catch (error) {
    const code = error instanceof HostRequestError ? error.code : '';
    const message =
      code === 'NO_SERVICE'
        ? 'Deleting needs this extension’s local helper. Approve it in Settings → Extensions.'
        : code === 'SERVICE_FAILED'
          ? 'The helper could not start, so nothing was deleted.'
          : failure(error);
    if (editing) {
      editing.error = message;
      render();
    } else {
      await host.toast({ kind: 'error', message });
    }
    return;
  }

  if (answer.status !== 200) {
    let message = `The helper answered ${answer.status}.`;
    try {
      const body: unknown = JSON.parse(answer.body || '{}');
      const said = body && typeof body === 'object' ? (body as Record<string, unknown>).message : null;
      if (typeof said === 'string' && said !== '') message = said;
    } catch {
      // keep the status line
    }
    if (editing) {
      editing.error = message;
      render();
    } else {
      await host.toast({ kind: 'error', message });
    }
    return;
  }

  editing = null;
  await host.toast({ kind: 'success', message: `Deleted ${agent.name}.` });
  await load();
};

const emptyDraft = (): Draft => ({
  name: '',
  description: '',
  model: '',
  mode: 'subagent',
  temperature: '',
  prompt: '',
  customModel: false,
  permissions: [],
});

const draftOf = (agent: Agent): Draft => ({
  name: agent.name,
  description: agent.description,
  model: agent.model,
  mode: agent.mode,
  temperature: readField(agent.file, 'temperature') ?? '',
  prompt: agent.file.body.trim(),
  customModel: false,
  permissions: readPermissionList(agent.file),
});

const save = async (): Promise<void> => {
  if (!editing) return;
  const { agent, draft } = editing;
  const name = draft.name.trim();

  if (!agent) {
    if (!NAME_SHAPE.test(name)) {
      editing.error = 'A name uses lowercase letters, numbers and dashes, and starts with a letter.';
      render();
      return;
    }
  }
  if (draft.description.trim() === '') {
    editing.error = 'Write a description: it is how a model decides to pick this agent.';
    render();
    return;
  }
  const temperature = draft.temperature.trim();
  if (temperature !== '' && !/^\d+(\.\d+)?$/.test(temperature)) {
    editing.error = 'Temperature is a number, such as 0.2.';
    render();
    return;
  }

  const updates: Record<string, string | string[] | null> = {
    description: draft.description.trim(),
    model: draft.model.trim() === '' ? null : draft.model.trim(),
    mode: draft.mode === '' ? null : draft.mode,
    temperature: temperature === '' ? null : temperature,
    // `disable` is left out on purpose: only the list's switch owns it, so
    // saving an agent that is off keeps it off.
  };
  // The permissions block is rewritten only when a rule changed, so an agent
  // whose permissions were never touched keeps its file byte for byte.
  if (draft.permissions !== null) {
    const before = agent ? readPermissionList(agent.file) : [];
    if (JSON.stringify(draft.permissions) !== JSON.stringify(before)) {
      updates.permissions = draft.permissions.length === 0 ? null : permissionListLines(draft.permissions);
    }
  }

  const base: AgentFile = agent ? agent.file : { entries: [], hadFrontmatter: false, body: '' };
  const text = writeAgentFile(base, updates, draft.prompt);
  const path = agent ? agent.path : `${await targetDir(scope)}/${name}.md`;

  if (!agent) {
    try {
      const info = await host.stat(path);
      if (info.kind !== 'missing') {
        editing.error = `${name}.md already exists here.`;
        render();
        return;
      }
    } catch (error) {
      editing.error = failure(error);
      render();
      return;
    }
  }

  try {
    await host.writeFile(path, text);
  } catch (error) {
    editing.error = failure(error);
    render();
    return;
  }
  editing = null;
  await host.toast({
    kind: 'success',
    message: agent ? `Saved ${name}. New sessions pick it up.` : `Created ${name}. New sessions pick it up.`,
  });
  await load();
};

// ---------------------------------------------------------------- list view

const paintRows = (into: HTMLElement): void => {
  into.replaceChildren();

  if (loading) {
    mountSpinner(into, { label: 'Reading agent files…' });
    return;
  }
  if (loadError) {
    mountBanner(into, { tone: 'error', title: 'Could not read the agents', body: loadError });
    return;
  }
  if (scope === 'project' && !directory) {
    mountEmpty(into, {
      title: 'No project open',
      body: 'Project agents live in .opencode/agents of the open project.',
    });
    return;
  }

  const needle = query.trim().toLowerCase();
  const shown = needle
    ? agents.filter(
        (agent) =>
          agent.name.toLowerCase().includes(needle) ||
          agent.description.toLowerCase().includes(needle) ||
          agent.model.toLowerCase().includes(needle),
      )
    : agents;

  if (shown.length === 0) {
    mountEmpty(into, {
      title: agents.length === 0 ? 'No agents yet' : 'Nothing matches',
      body:
        agents.length === 0
          ? scope === 'global'
            ? 'Agents here are markdown files in ~/.config/opencode/agents.'
            : 'Agents here are markdown files in .opencode/agents of this project.'
          : 'Clear the search to see every agent.',
      action:
        agents.length === 0
          ? {
              label: 'New agent',
              onClick: () => {
                editing = { agent: null, draft: emptyDraft(), error: null };
                render();
              },
            }
          : undefined,
    });
    return;
  }

  const rows = el('div', 'rows');
  for (const agent of shown) {
    const row = el('div', 'row');
    row.dataset.off = String(agent.disabled);

    const main = el('button', 'row-main');
    main.type = 'button';
    const top = el('div', 'row-top');
    top.append(el('span', 'row-name', agent.name));
    if (agent.mode) mountBadge(top, { label: agent.mode, tone: 'neutral' });
    main.append(top);
    if (agent.description) main.append(el('div', 'row-desc', agent.description));
    if (agent.model) main.append(el('div', 'row-model', agent.model));
    main.addEventListener('click', () => {
      editing = { agent, draft: draftOf(agent), error: null };
      render();
    });

    const side = el('div', 'row-side');
    const toggle = mountSwitch(side, {
      label: agent.disabled ? 'Off' : 'On',
      checked: !agent.disabled,
      onChange: (checked) => {
        void setEnabled(agent, checked, paint);
      },
    });
    const paint = (enabled: boolean): void => {
      row.dataset.off = String(!enabled);
      toggle.update({ label: enabled ? 'On' : 'Off', checked: enabled });
    };

    row.append(main, side);
    rows.append(row);
  }
  into.append(rows);
};

const renderList = (): void => {
  const bar = el('div', 'bar');
  root.append(bar);

  const tabsHolder = el('div');
  bar.append(tabsHolder);
  const tabs = mountTabs(tabsHolder, {
    items: [
      { id: 'global', label: 'Global' },
      { id: 'project', label: 'Project' },
    ],
    activeId: scope,
    onChange: (next) => {
      scope = next as Scope;
      tabs.update({ activeId: scope });
      void load();
    },
  });

  bar.append(el('div', 'grow'));
  const newHolder = el('div');
  bar.append(newHolder);
  mountButton(newHolder, {
    label: 'New',
    size: 'sm',
    disabled: scope === 'project' && !directory,
    onClick: () => {
      editing = { agent: null, draft: emptyDraft(), error: null };
      render();
    },
  });

  const searchHolder = el('div');
  root.append(searchHolder);
  const rowsHolder = el('div');
  root.append(rowsHolder);

  mountSearchField(searchHolder, {
    value: query,
    placeholder: 'Search agents',
    onChange: (next) => {
      query = next;
      paintRows(rowsHolder); // keeps the field focused while typing
    },
  });

  paintRows(rowsHolder);

  root.append(
    el(
      'div',
      'muted',
      scope === 'global'
        ? '~/.config/opencode/agents · built-in agents (build, plan) are not files and are not listed.'
        : '.opencode/agents in this project.',
    ),
  );
};

// ----------------------------------------------------- permissions accordion

const EFFECT_TABS = [
  { id: 'inherit', label: 'Inherit' },
  { id: 'allow', label: 'Allow' },
  { id: 'ask', label: 'Ask' },
  { id: 'deny', label: 'Deny' },
];
const DEFAULT_TABS = [{ id: 'default', label: 'Default' }, ...EFFECT_TABS.slice(1)];
const PATTERN_TABS = EFFECT_TABS.slice(1);
const PATTERN_OPTIONS = PATTERN_TABS.map((tab) => ({ id: tab.id, label: tab.label }));
/** A tool name, or a MCP server's `name_*` form. */
const ACTION_NAME = /^[A-Za-z_][A-Za-z0-9_-]*\*?$/;

const notify = (message: string): void => {
  void host.toast({ kind: 'error', message });
};

/** `external_directory` reads as `External Directory`. */
const titleOf = (name: string): string =>
  name
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

/** The effect a row resolves to: its own rule, else the agent's default, else the global config. */
const effectiveHint = (entries: PermissionEntry[], action: string): string => {
  const own = effectOf(entries, action);
  if (own) return `→ ${own}`;
  const fallback = effectOf(entries, '*');
  return fallback ? `→ ${fallback}` : '→ from global config';
};

/** A native disclosure. Its open state is remembered, so a re-render keeps it. */
const accordion = (
  id: string,
  title: string,
  meta: string,
  body: Element[],
  nested = false,
): HTMLDetailsElement => {
  const details = el('details', nested ? 'acc acc-nested' : 'acc');
  details.open = OPEN_SECTIONS.has(id);
  details.addEventListener('toggle', () => {
    if (details.open) OPEN_SECTIONS.add(id);
    else OPEN_SECTIONS.delete(id);
  });
  const summary = el('summary', 'acc-head');
  summary.append(el('span', 'acc-title', title), el('span', 'muted', meta));
  details.append(summary, ...body);
  return details;
};

/** Add or replace a pattern under one action. */
const addPatternRow = (draft: Draft, action: string): HTMLElement => {
  let pattern = '';
  let effect = 'ask';
  const add = el('div', 'perm-add');

  const patternHolder = el('div', 'perm-grow');
  add.append(patternHolder);
  mountTextField(patternHolder, {
    label: 'Pattern',
    value: '',
    mono: true,
    placeholder: 'git status*',
    onChange: (next) => {
      pattern = next;
    },
  });

  const effectHolder = el('div');
  add.append(effectHolder);
  const effectSelect = mountSelect(effectHolder, {
    label: 'Permission',
    value: effect,
    options: PATTERN_OPTIONS,
    onChange: (next) => {
      effect = next;
      effectSelect.update({ value: next });
    },
  });

  const addHolder = el('div');
  add.append(addHolder);
  mountButton(addHolder, {
    label: 'Add pattern',
    variant: 'ghost',
    size: 'sm',
    onClick: () => {
      const text = pattern.trim();
      if (text === '' || text === '*') {
        notify('Write a pattern such as git status*. The bare * is the tool’s own rule above.');
        return;
      }
      const entries = draft.permissions ?? [];
      if (entries.some((entry) => entry.action === action && entry.resource === text)) {
        notify(`${action} already has ${text}.`);
        return;
      }
      draft.permissions = setPattern(entries, action, text, effect);
      render();
    },
  });
  return add;
};

/** The pattern rules under one action, in their own accordion. */
const patternAccordion = (draft: Draft, action: string): HTMLElement => {
  const patterns = patternsOf(draft.permissions ?? [], action);
  const list = el('div', 'perm-list');
  if (patterns.length === 0) {
    list.append(el('div', 'muted', 'No patterns. A pattern narrows the rule above, such as git status* for bash.'));
  }
  for (const rule of patterns) {
    const row = el('div', 'perm-row');
    row.append(el('span', 'perm-name mono', rule.resource));

    const effectHolder = el('div', 'perm-value');
    row.append(effectHolder);
    mountTabs(effectHolder, {
      items: PATTERN_TABS,
      activeId: rule.effect,
      onChange: (next) => {
        draft.permissions = setPattern(draft.permissions ?? [], action, rule.resource, next);
        render();
      },
    });

    const dropHolder = el('div');
    row.append(dropHolder);
    mountButton(dropHolder, {
      label: '×',
      variant: 'ghost',
      size: 'xs',
      onClick: () => {
        draft.permissions = removePattern(draft.permissions ?? [], action, rule.resource);
        render();
      },
    });
    list.append(row);
  }
  const count = patterns.length;
  return accordion(
    `perm:${action}`,
    'Patterns',
    count === 0 ? 'none' : `${count} ${count === 1 ? 'pattern' : 'patterns'}`,
    [list, addPatternRow(draft, action)],
    true,
  );
};

/**
 * One tool: its title, what it resolves to, its effect tabs, and its patterns.
 * `isDefault` is the `*` row, whose inherit tab is "Default".
 */
const toolRow = (draft: Draft, action: string, title: string, isDefault = false): HTMLElement => {
  const entries = draft.permissions ?? [];
  const own = effectOf(entries, action);
  const row = el('div', 'tool');

  const head = el('div', 'tool-head');
  head.append(el('span', 'tool-title', title));
  if (title !== action) head.append(el('span', 'tool-action mono', action));
  head.append(el('span', 'tool-hint muted', isDefault ? (own ? `→ ${own}` : '→ from global config') : effectiveHint(entries, action)));
  row.append(head);

  const tabsHolder = el('div', 'tool-tabs');
  row.append(tabsHolder);
  mountTabs(tabsHolder, {
    items: isDefault ? DEFAULT_TABS : EFFECT_TABS,
    activeId: own ?? (isDefault ? 'default' : 'inherit'),
    onChange: (next) => {
      const effect = next === 'inherit' || next === 'default' ? null : next;
      draft.permissions = setEffect(draft.permissions ?? [], action, effect);
      render();
    },
  });

  if (!isDefault) row.append(patternAccordion(draft, action));
  return row;
};

/** Adds a rule for a tool the list does not show, such as a new tool or `github_*`. */
const addToolRow = (draft: Draft): HTMLElement => {
  let name = '';
  let effect = 'ask';
  const add = el('div', 'perm-add');

  const nameHolder = el('div', 'perm-grow');
  add.append(nameHolder);
  mountTextField(nameHolder, {
    label: 'Tool',
    value: '',
    mono: true,
    placeholder: 'bash or github_*',
    onChange: (next) => {
      name = next;
    },
  });

  const effectHolder = el('div');
  add.append(effectHolder);
  const effectSelect = mountSelect(effectHolder, {
    label: 'Permission',
    value: effect,
    options: PATTERN_OPTIONS,
    onChange: (next) => {
      effect = next;
      effectSelect.update({ value: next });
    },
  });

  const addHolder = el('div');
  add.append(addHolder);
  mountButton(addHolder, {
    label: 'Add tool',
    variant: 'ghost',
    size: 'sm',
    onClick: () => {
      const action = name.trim();
      if (!ACTION_NAME.test(action)) {
        notify('A tool name uses letters, digits, dashes and underscores, such as bash or github_*.');
        return;
      }
      if (effectOf(draft.permissions ?? [], action) !== null) {
        notify(`${action} already has a rule.`);
        return;
      }
      draft.permissions = setEffect(draft.permissions ?? [], action, effect);
      render();
    },
  });
  return add;
};

const permissionSection = (draft: Draft): HTMLElement => {
  const entries = draft.permissions ?? [];
  const mcpActions = mcpServers.map((server) => `${server}_*`);
  const body: Element[] = [toolRow(draft, '*', 'Default for all tools', true)];

  for (const name of BUILTIN_TOOLS) body.push(toolRow(draft, name, titleOf(name)));

  if (mcpServers.length > 0) {
    body.push(
      accordion(
        'perm:mcp',
        'MCP servers',
        `${mcpServers.length} ${mcpServers.length === 1 ? 'server' : 'servers'}`,
        mcpServers.map((server) => toolRow(draft, `${server}_*`, server)),
        true,
      ),
    );
  }

  body.push(
    accordion(
      'perm:openchamber',
      'OpenChamber tools',
      `${OPENCHAMBER_TOOLS.length} tools`,
      OPENCHAMBER_TOOLS.map((name) => toolRow(draft, name, name)),
      true,
    ),
  );

  const others = otherActions(entries, [...BUILTIN_TOOLS, ...OPENCHAMBER_TOOLS, ...mcpActions]);
  if (others.length > 0) {
    body.push(
      accordion(
        'perm:other',
        'Other rules in this file',
        `${others.length}`,
        others.map((name) => toolRow(draft, name, name)),
        true,
      ),
    );
  }

  body.push(addToolRow(draft));

  return accordion(
    'permissions',
    'Tool permissions',
    entries.length === 0 ? 'defaults' : `${entries.length} ${entries.length === 1 ? 'rule' : 'rules'}`,
    body,
  );
};

// -------------------------------------------------------------- editor view

const renderEditor = (): void => {
  const current = editing!;
  const { agent, draft } = current;

  const bar = el('div', 'bar');
  const backHolder = el('div');
  bar.append(backHolder);
  mountButton(backHolder, {
    label: 'Back',
    variant: 'ghost',
    size: 'sm',
    onClick: () => {
      editing = null;
      render();
    },
  });
  // The kit's button only repaints its label span, so an icon prepended here stays.
  backHolder.querySelector('button')?.prepend(iconSvg(ARROW_LEFT));
  bar.append(el('div', 'grow'));
  bar.append(el('div', 'muted mono', agent ? agent.path : `new in ${scope === 'global' ? '~/.config/opencode/agents' : '.opencode/agents'}`));
  root.append(bar);

  if (current.error) {
    const banner = el('div');
    root.append(banner);
    mountBanner(banner, { tone: 'error', title: current.error });
  }

  const fields = el('div', 'fields');
  root.append(fields);

  if (!agent) {
    const holder = el('div');
    fields.append(holder);
    mountTextField(holder, {
      label: 'Name',
      value: draft.name,
      mono: true,
      placeholder: 'code-reviewer',
      helper: 'Becomes the file name and the name agents are called by.',
      onChange: (value) => {
        draft.name = value;
      },
    });
  }

  const descHolder = el('div');
  fields.append(descHolder);
  mountTextField(descHolder, {
    label: 'Description',
    value: draft.description,
    multiline: true,
    rows: 5,
    placeholder: 'Reviews a diff and reports findings. Never edits files.',
    helper: 'When to use this agent. A model reads this to decide.',
    onChange: (value) => {
      draft.description = value;
    },
  });

  const pairOne = el('div', 'pair');
  fields.append(pairOne);
  const modeHolder = el('div');
  pairOne.append(modeHolder);
  const modeOptions = [
    { id: 'subagent', label: 'Subagent', hint: 'delegated to' },
    { id: 'primary', label: 'Primary', hint: 'chosen for a session' },
    { id: 'all', label: 'Both' },
    { id: 'unset', label: 'Not set', hint: "OpenCode's default" },
  ];
  if (draft.mode !== '' && !modeOptions.some((option) => option.id === draft.mode)) {
    modeOptions.unshift({ id: draft.mode, label: draft.mode, hint: 'as written' });
  }
  const modeSelect = mountSelect(modeHolder, {
    label: 'Mode',
    value: draft.mode === '' ? 'unset' : draft.mode,
    options: modeOptions,
    onChange: (value) => {
      draft.mode = value === 'unset' ? '' : value;
      modeSelect.update({ value });
    },
  });

  const modelHolder = el('div');
  pairOne.append(modelHolder);
  if (draft.customModel) {
    mountTextField(modelHolder, {
      label: 'Model',
      value: draft.model,
      mono: true,
      placeholder: 'claude-code/claude-opus-5',
      helper: 'provider/model, as OpenCode writes it.',
      onChange: (value) => {
        draft.model = value;
      },
    });
    const pickHolder = el('div');
    modelHolder.append(pickHolder);
    mountButton(pickHolder, {
      label: 'Choose from the list',
      variant: 'ghost',
      size: 'xs',
      onClick: () => {
        draft.customModel = false;
        render();
      },
    });
  } else {
    const modelOptions = [
      { id: INHERIT_MODEL, label: 'Session model', hint: 'inherit' },
      ...models.map((option) => ({ id: option.id, label: option.id, hint: option.hint })),
    ];
    if (draft.model !== '' && !models.some((option) => option.id === draft.model)) {
      modelOptions.splice(1, 0, { id: draft.model, label: draft.model, hint: 'as written' });
    }
    modelOptions.push({ id: OTHER_MODEL, label: 'Other…', hint: 'type an id' });
    const modelSelect = mountSelect(modelHolder, {
      label: 'Model',
      value: draft.model === '' ? INHERIT_MODEL : draft.model,
      options: modelOptions,
      searchable: modelOptions.length > 8,
      searchPlaceholder: 'Search models',
      onChange: (value) => {
        if (value === OTHER_MODEL) {
          draft.customModel = true;
          render();
          return;
        }
        draft.model = value === INHERIT_MODEL ? '' : value;
        modelSelect.update({ value });
      },
    });
  }

  const tempHolder = el('div');
  fields.append(tempHolder);
  mountTextField(tempHolder, {
    label: 'Temperature',
    value: draft.temperature,
    mono: true,
    placeholder: 'optional',
    onChange: (value) => {
      draft.temperature = value;
    },
  });
  const tempInput = tempHolder.querySelector('input');
  if (tempInput) {
    tempInput.type = 'number';
    tempInput.step = '0.1';
    tempInput.min = '0';
    tempInput.max = '2';
    tempInput.inputMode = 'decimal';
  }

  if (draft.permissions !== null) fields.append(permissionSection(draft));

  const promptHolder = el('div');
  fields.append(promptHolder);
  mountTextField(promptHolder, {
    label: 'Instructions',
    value: draft.prompt,
    multiline: true,
    rows: 14,
    mono: true,
    placeholder: 'What the agent does, how it answers, what it must not do.',
    onChange: (value) => {
      draft.prompt = value;
    },
  });

  if (agent) {
    const kept = untouchedKeys(agent.file, draft.permissions !== null ? [...OWNED, 'permissions'] : OWNED);
    if (kept.length > 0) {
      fields.append(el('div', 'muted', `Kept as written: ${kept.join(', ')}.`));
    }
  }

  const foot = el('div', 'foot');
  root.append(foot);
  const saveHolder = el('div');
  foot.append(saveHolder);
  mountButton(saveHolder, {
    label: agent ? 'Save' : 'Create agent',
    onClick: () => {
      void save();
    },
  });
  const cancelHolder = el('div');
  foot.append(cancelHolder);
  mountButton(cancelHolder, {
    label: 'Cancel',
    variant: 'ghost',
    onClick: () => {
      editing = null;
      render();
    },
  });
  foot.append(el('div', 'grow'));

  if (agent) {
    const deleteHolder = el('div');
    foot.append(deleteHolder);
    let armed = false;
    const deleteButton = mountButton(deleteHolder, {
      label: 'Delete',
      variant: 'destructive',
      size: 'sm',
      onClick: () => {
        if (!armed) {
          // First click arms it, the second one deletes: no dialog to mis-click.
          armed = true;
          deleteButton.update({ label: `Delete ${agent.name}?` });
          return;
        }
        deleteButton.update({ label: 'Deleting…', loading: true });
        void remove(agent);
      },
    });
  }
};

const render = (): void => {
  root.replaceChildren();
  if (editing) renderEditor();
  else renderList();
};

host.onDirectory((next) => {
  const changed = next !== directory;
  directory = next;
  if (!started) return;
  if (changed && scope === 'project') void load();
  else if (changed) render();
});

host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  directory = context.directory;
  sessionModel = context.session?.model ?? sessionModel;
  if (started) return;
  started = true;
  void load();
});
