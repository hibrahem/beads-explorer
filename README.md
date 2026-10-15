# Beads Explorer

A local web app for any repository's [beads](https://github.com/steveyegge/beads) issues and memories. Browse and edit them, link them, see the dependency graph, and ask an AI about one issue.

```bash
cd any/repo/that/uses/beads
beads-explorer
```

See [Install](#install) to set it up. It finds the nearest folder holding `.beads`, from wherever you are inside the repository, and opens it in your browser at http://127.0.0.1:4410. If that port is taken, for example because another repository is already open, it uses the next free one. Stop it with Ctrl-C.

## Install

You need:

- **Node.js 20 or newer:** check with `node --version`.
- **beads:** the `bd` command on your PATH ([install beads](https://github.com/steveyegge/beads)). Check with `bd --version`.
- **Optional, for the AI chat:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`), signed in, or an Anthropic API key.

Clone the repository and link the command:

```bash
git clone https://github.com/hibrahem/beads-explorer.git
cd beads-explorer
npm install
npm link
```

`npm link` puts `beads-explorer` on your PATH and points it at the clone, so `git pull` there updates the command. To check that it worked:

```bash
beads-explorer --version
```

To install without keeping a clone, run `npm install -g github:hibrahem/beads-explorer`. While the repository is private, git needs to be signed in to GitHub for this to work.

To uninstall:

```bash
npm unlink -g beads-explorer
```

Use `npm uninstall -g beads-explorer` instead if you installed it with `npm install -g`.

## Run

```bash
cd path/to/any/repo/that/uses/beads
beads-explorer
```

Your browser opens on the repository's board. Leave the terminal running while you use it, and press Ctrl-C there to stop it.

## Usage

```
beads-explorer [repo-path] [--port <n>] [--owner <name>] [--no-open]
```

| Option | What it does |
|---|---|
| `repo-path` | Open another repository: any folder inside it works. |
| `--port <n>` | Use this port instead of 4410 or the next free one. |
| `--owner <name>` | Adds a "Waiting on &lt;name&gt;" list to Insights: open issues titled `<name>: …` or labelled with the name. |
| `--no-open` | Do not open the browser. |

## What you can do

| View | What it is for |
|---|---|
| Board | Issues by status. Drag a card to another column to change its status; closing asks for a reason. |
| List | A sortable table. Tick several issues to change their status or priority in one go. |
| Graph | The dependency graph. Arrows point from a blocker to the issue that waits on it; parent links are dashed. A green ring means ready and a red ring means blocked. Focus on one issue to see its neighbours. |
| Epics | Each epic with its progress, what is in progress, and what is ready next. |
| Insights | Counts by status, priority and type, plus what is ready now (the same rule as `bd ready`), urgent (P0 and P1), blocked, stale (no update in 14 days) and recently closed. |
| Memories | Everything saved with `bd remember`: search, edit, add and delete. |

Open an issue to see and edit its title (double-click it, or press Enter on it), status, priority, assignee, labels, description, design, acceptance and notes (Markdown), its links in both directions, its children and its comments. **Ask AI** opens a chat about that issue.

Keyboard: `/` search, `j`/`k` move, `Enter` open, `Esc` close, `g b`/`g l`/`g g`/`g e`/`g i`/`g m` switch views, `n` new issue, `r` reload.

## Ask AI

The chat runs your own Claude Code (`claude -p`) in the repository, with your existing sign-in. Each run gets:
- **Tools:** only Read, Grep and Glob. It has no shell and cannot change files or beads.
- **Settings:** none of the repository's or your user settings, plugins, hooks or MCP servers.
- **Blocked files:** secret files such as `.env*`, keys and `~/.ssh`.
- **Context:** the issue, its links, its comments and the commits that mention it, plus a read-only snapshot of all issues and memories.

When the AI recommends a change, it shows as a card. **Nothing changes until you press Apply.** Suggested notes are added to the existing notes, never replacing them.

If the chat says Claude Code is not signed in, run `claude` in a terminal and `/login`. Or use an API key:

```bash
ANTHROPIC_API_KEY=sk-... beads-explorer
```

## Safety

- **Local only:** it listens on 127.0.0.1 and only answers requests addressed to 127.0.0.1 or localhost on its own port.
- **Every API call needs the page's token:** the server makes a fresh token each time it starts, so other sites cannot use it.
- **No conflicting edits:** an edit to an issue that changed since you opened it (in another session, or from the terminal) is refused, and the page reloads it.
- **One `bd` call at a time:** the embedded Dolt database holds one lock.
- **No `bd show`:** it rewrites `.beads/last-touched`, which id-less `bd` commands in other sessions act on.
- **No third-party scripts at run time:** the five libraries are served from `public/vendor` (see its README).

## Settings

| Variable | Default | What it does |
|---|---|---|
| `BEADS_EXPLORER_PORT` | 4410 | Port to listen on |
| `BEADS_EXPLORER_OWNER` | unset | Same as `--owner` |
| `BEADS_EXPLORER_NO_OPEN` | unset | Set to skip opening the browser |
| `BEADS_EXPLORER_BD` | `bd` | Path to the bd binary |
| `BEADS_EXPLORER_CLAUDE` | `claude` | Path to the Claude Code binary |
| `ANTHROPIC_API_KEY` | unset | Use the Anthropic API for the chat instead of Claude Code |
| `BEADS_EXPLORER_MODEL` | Claude Code's default; `claude-opus-5-5` for the API | Model for the chat |
| `BEADS_EXPLORER_MAX_USD` | 1 | Spending cap per Claude Code chat turn |

## Development

```bash
npm test
```

The design and its two review rounds are in `docs/design.md`.
