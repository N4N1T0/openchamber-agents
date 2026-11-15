# Agents — an OpenChamber extension

A panel on OpenChamber's rail that lists your OpenCode agents and lets you turn
them off, turn them on, edit them and create new ones. Your agents stay plain
markdown files; this is a front end for them, not another place to keep them.

[**Install in OpenChamber**](openchamber://extensions/install?url=https%3A%2F%2Fgithub.com%2FN4N1T0%2Fopenchamber-agents)

Or add the repository URL in Settings → Extensions.

## What it does

- **Lists every agent that is a file**, under two tabs: **Global**
  (`~/.config/opencode/agents`, and the older `agent/`) and **Project**
  (`.opencode/agents` of the project you have open). Name, mode, description and
  model on each row.
- **A switch on each row** turns an agent off or on. Off writes `disable: true`
  into the frontmatter, and switching back on removes the key again. The row
  changes immediately and only moves back if the write fails, so the list keeps
  its scroll position and your search text.
- **Click a row to edit**: description, mode, model, temperature and the
  instructions body.
- **New** creates an agent in that tab's folder, after checking the name and
  that the file is not already there.
- **Delete** sits in the editor, and takes two clicks.
- **Search** filters by name, description or model.

Changes land in new sessions. A session that is already running keeps the agent
it started with.

## Saving never reformats the rest of your file

The frontmatter writer only replaces the keys the panel edits. Every other line
is carried through exactly as written — `permission` blocks, `tools` maps,
comments, block scalars, key order, a `prompt` you keep in the frontmatter. The
editor shows a line like *Kept as written: permissions* so you can see what it
left alone. `bun test` covers this with fixtures taken from real agent files.

A key the panel does edit is rewritten in a single-quoted form, so a description
with a colon or an apostrophe in it stays valid YAML.

## The model list

OpenChamber hands no model catalogue to an extension, so the dropdown is the
models you actually work with: the favourites, default, recents and remembered
efforts from OpenChamber's own picker (read from `preferences.json`), minus the
ones you hid there, plus every model an agent file already names and the model of
the open session. **Other…** switches to a text field for an id that is not in
the list, and a model already in a file is always offered, marked *as written*.

If that file cannot be read, the list falls back to the models your agent files
name. Nothing breaks.

## What it asks for, and why

| It asks for | For |
|---|---|
| Project files | Reading and writing `.opencode/agents` of the open project |
| `~/.config/opencode/agents`, `~/.config/opencode/agent` | Your global agents |
| `~/.config/openchamber/preferences.json` (read) | The model list. Themes, notifications and the model/agent picker's memory live there; no tokens, those are in `~/.config/openchamber/secrets/`, which this extension cannot reach |
| A local service | Deleting. See below |

The extension declares no network origins, so nothing it reads leaves your
machine.

### Why deleting needs a service

The extension file API can read, write, list and stat — it cannot delete. A
local service is the only part of an extension that can, and OpenChamber says
plainly in the approval dialog that a service runs with your full access.

So the service takes no path from the panel. It takes a scope (`global` or
`project`), one of OpenCode's two folder names (`agents` or `agent`) and a bare
agent name, and builds the path itself. The name must match
`^[A-Za-z0-9][A-Za-z0-9._-]*$`, so it can hold no slash, no `..` and no leading
dot, and the only paths the service can reach are:

```
<home>/.config/opencode/{agents,agent}/<name>.md
<project>/.opencode/{agents,agent}/<name>.md
```

Before deleting it uses `lstat`, not `stat`: a `.md` that is a symlink is
refused instead of followed, and so is a directory. Anything else answers 400
and touches nothing. The service does nothing else — no clock, no session
access, no network — and stops on its own after ten quiet minutes.

Until you approve it, deleting says so and the rest of the panel works.

## Limits

- Built-in agents (`build`, `plan`, `general`, `explore`) are not files, so they
  are not listed. You can still shadow one by creating an agent with that name.
- Agents defined inside `opencode.json` are not listed either; this panel edits
  markdown agent files.
- VS Code and the phone load no extensions.

## Development

```sh
bun install
bun test
bunx tsc --noEmit
bunx openchamber-guest-bundle panel/main.ts panel/main.js
bunx openchamber-guest-bundle --node service/main.ts service/main.js
bunx openchamber-guest-check
```

The built `.js` files are committed, because installing an extension never
builds it. CI rebuilds them and fails if they differ from the sources, so a
stale bundle cannot reach anyone.

| Path | What it is |
|---|---|
| `panel/main.ts` | The panel: list, editor, file reads and writes |
| `panel/frontmatter.ts` | Reading and rewriting agent frontmatter without disturbing it |
| `panel/models.ts` | Building the model list |
| `service/main.ts` | The delete service |

## Licence

MIT. See [LICENSE](LICENSE).
