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
  hasOpaqueField,
  parseAgentFile,
  readField,
  untouchedKeys,
  writeAgentFile,
  type AgentFile,
} from './frontmatter';
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
};

/** Frontmatter keys this panel owns. Everything else is carried through. */
const OWNED = ['description', 'model', 'mode', 'temperature', 'disable'];

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
/** Where OpenCode looks for skills (`SKILL.md` folders and root `*.md` files). */
const SKILL_DIRS: Record<Scope, string> = {
  global: '~/.config/opencode/skills',
  project: '.opencode/skills',
};

type View = 'agents' | 'skills';

/** A skill as the panel sees it. Only `disable-model-invocation` is edited. */
type Skill = {
  scope: Scope;
  /** The ID OpenCode loads it by: the folder or file name, never the frontmatter `name`. */
  id: string;
  path: string;
  name: string;
  description: string;
  file: AgentFile;
  /** False when `disable-model-invocation: true` is set. */
  invocable: boolean;
};

const host = connectHost();
const root = document.querySelector<HTMLElement>('#root')!;

let directory: string | null = null;
let sessionModel: string | null = null;
let scope: Scope = 'global';
let query = '';
let loading = false;
let loadError: string | null = null;
let view: View = 'agents';
let agents: Agent[] = [];
let skills: Skill[] = [];
let models: ModelOption[] = [];
let editing: { agent: Agent | null; draft: Draft; error: string | null } | null = null;
let skillEditing: { skill: Skill; invocable: boolean; error: string | null } | null = null;
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

const toSkill = (target: Scope, id: string, path: string, text: string): Skill => {
  const file = parseAgentFile(text);
  return {
    scope: target,
    id,
    path,
    name: readField(file, 'name') || id,
    description: readField(file, 'description') ?? '',
    file,
    invocable: (readField(file, 'disable-model-invocation') ?? 'false').trim() !== 'true',
  };
};

const readSkills = async (target: Scope): Promise<Skill[]> => {
  const dir = SKILL_DIRS[target];
  let entries: { name: string; kind: string }[] = [];
  try {
    const info = await host.stat(dir);
    if (info.kind !== 'directory') return [];
    entries = (await host.listDir(dir)).entries;
  } catch {
    return []; // no skills folder yet
  }
  const found: Skill[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    let id: string;
    let path: string;
    if (entry.kind === 'file' && entry.name.toLowerCase().endsWith('.md')) {
      id = entry.name.slice(0, -3);
      path = `${dir}/${entry.name}`;
    } else if (entry.kind === 'directory') {
      id = entry.name;
      path = `${dir}/${entry.name}/SKILL.md`;
    } else {
      continue;
    }
    try {
      const { content } = await host.readFile(path);
      found.push(toSkill(target, id, path, content));
    } catch {
      // A folder without a SKILL.md, or an unreadable file: not a skill.
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

const load = async (): Promise<void> => {
  if (scope === 'project' && !directory) {
    agents = [];
    skills = [];
    loadError = null;
    render();
    return;
  }
  loading = true;
  loadError = null;
  render();
  try {
    if (view === 'skills') {
      skills = await readSkills(scope);
    } else {
      agents = await readAgents(scope);
    }
  } catch (error) {
    agents = [];
    skills = [];
    loadError = failure(error);
  }
  if (view === 'agents') models = await readModels(agents.map((agent) => agent.model));
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
});

const draftOf = (agent: Agent): Draft => ({
  name: agent.name,
  description: agent.description,
  model: agent.model,
  mode: agent.mode,
  temperature: readField(agent.file, 'temperature') ?? '',
  prompt: agent.file.body.trim(),
  customModel: false,
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

  const updates: Record<string, string | null> = {
    description: draft.description.trim(),
    model: draft.model.trim() === '' ? null : draft.model.trim(),
    mode: draft.mode === '' ? null : draft.mode,
    temperature: temperature === '' ? null : temperature,
    // `disable` is left out on purpose: only the list's switch owns it, so
    // saving an agent that is off keeps it off.
  };

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

const paintSkillRows = (into: HTMLElement): void => {
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? skills.filter(
        (skill) =>
          skill.name.toLowerCase().includes(needle) ||
          skill.id.toLowerCase().includes(needle) ||
          skill.description.toLowerCase().includes(needle),
      )
    : skills;

  if (shown.length === 0) {
    mountEmpty(into, {
      title: skills.length === 0 ? 'No skills yet' : 'Nothing matches',
      body:
        skills.length === 0
          ? scope === 'global'
            ? 'Skills here are folders with a SKILL.md in ~/.config/opencode/skills.'
            : 'Skills here are folders with a SKILL.md in .opencode/skills of this project.'
          : 'Clear the search to see every skill.',
    });
    return;
  }

  const rows = el('div', 'rows');
  for (const skill of shown) {
    const row = el('div', 'row');
    row.dataset.off = String(!skill.invocable);

    const main = el('button', 'row-main');
    main.type = 'button';
    const top = el('div', 'row-top');
    top.append(el('span', 'row-name', skill.name));
    if (!skill.invocable) mountBadge(top, { label: 'hidden from the model', tone: 'neutral' });
    main.append(top);
    if (skill.description) main.append(el('div', 'row-desc', skill.description));
    main.append(el('div', 'row-model', skill.id));
    main.addEventListener('click', () => {
      skillEditing = { skill, invocable: skill.invocable, error: null };
      render();
    });

    row.append(main);
    rows.append(row);
  }
  into.append(rows);
};

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
      body: `Project ${view === 'skills' ? 'skills' : 'agents'} live in ${view === 'skills' ? '.opencode/skills' : '.opencode/agents'} of the open project.`,
    });
    return;
  }
  if (view === 'skills') {
    paintSkillRows(into);
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
  const viewHolder = el('div');
  root.append(viewHolder);
  const viewTabs = mountTabs(viewHolder, {
    items: [
      { id: 'agents', label: 'Agents' },
      { id: 'skills', label: 'Skills' },
    ],
    activeId: view,
    onChange: (next) => {
      view = next as View;
      viewTabs.update({ activeId: view });
      query = '';
      void load();
    },
  });

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
  if (view === 'agents') {
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
  }

  const searchHolder = el('div');
  root.append(searchHolder);
  const rowsHolder = el('div');
  root.append(rowsHolder);

  mountSearchField(searchHolder, {
    value: query,
    placeholder: view === 'agents' ? 'Search agents' : 'Search skills',
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
      view === 'skills'
        ? scope === 'global'
          ? '~/.config/opencode/skills'
          : '.opencode/skills in this project.'
        : scope === 'global'
          ? '~/.config/opencode/agents · built-in agents (build, plan) are not files and are not listed.'
          : '.opencode/agents in this project.',
    ),
  );
};

// -------------------------------------------------------------- skill editor

const invocableLabel = (on: boolean): string => (on ? 'Model can invoke it' : 'Hidden from the model');

const saveSkill = async (): Promise<void> => {
  if (!skillEditing) return;
  const { skill, invocable } = skillEditing;
  if (invocable === skill.invocable) {
    skillEditing = null;
    render();
    return;
  }
  const text = writeAgentFile(
    skill.file,
    { 'disable-model-invocation': invocable ? null : 'true' },
    skill.file.body,
  );
  try {
    await host.writeFile(skill.path, text);
  } catch (error) {
    skillEditing.error = failure(error);
    render();
    return;
  }
  skillEditing = null;
  await host.toast({
    kind: 'success',
    message: `Saved ${skill.name}. New sessions pick it up.`,
  });
  await load();
};

const renderSkillEditor = (): void => {
  const current = skillEditing!;
  const { skill } = current;

  const bar = el('div', 'bar');
  const backHolder = el('div');
  bar.append(backHolder);
  mountButton(backHolder, {
    label: 'Back',
    variant: 'ghost',
    size: 'sm',
    onClick: () => {
      skillEditing = null;
      render();
    },
  });
  backHolder.querySelector('button')?.prepend(iconSvg(ARROW_LEFT));
  bar.append(el('div', 'grow'));
  bar.append(el('div', 'muted mono', skill.path));
  root.append(bar);

  if (current.error) {
    const banner = el('div');
    root.append(banner);
    mountBanner(banner, { tone: 'error', title: current.error });
  }

  const fields = el('div', 'fields');
  root.append(fields);

  const info = el('div', 'skill-info');
  info.append(el('div', 'row-name', skill.name));
  info.append(el('div', 'row-model', skill.id));
  if (skill.description) info.append(el('div', 'muted', skill.description));
  fields.append(info);

  const switchHolder = el('div');
  fields.append(switchHolder);
  const invocableSwitch = mountSwitch(switchHolder, {
    label: invocableLabel(current.invocable),
    checked: current.invocable,
    onChange: (checked) => {
      current.invocable = checked;
      invocableSwitch.update({ label: invocableLabel(checked), checked });
    },
  });
  fields.append(
    el(
      'div',
      'muted',
      `Off writes disable-model-invocation: true into SKILL.md. The model stops listing the skill; you can still load it yourself with @${skill.id}.`,
    ),
  );
  if (hasOpaqueField(skill.file, 'metadata')) {
    fields.append(
      el(
        'div',
        'muted',
        'This skill has a metadata block. If it sets opencode/autoinvoke, that wins over this switch, and the panel leaves it as written.',
      ),
    );
  }

  const foot = el('div', 'foot');
  root.append(foot);
  const saveHolder = el('div');
  foot.append(saveHolder);
  mountButton(saveHolder, {
    label: 'Save',
    onClick: () => {
      void saveSkill();
    },
  });
  const cancelHolder = el('div');
  foot.append(cancelHolder);
  mountButton(cancelHolder, {
    label: 'Cancel',
    variant: 'ghost',
    onClick: () => {
      skillEditing = null;
      render();
    },
  });
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
    const kept = untouchedKeys(agent.file, OWNED);
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
  if (skillEditing) renderSkillEditor();
  else if (editing) renderEditor();
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
