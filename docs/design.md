# Beads Explorer: design

Status: implemented 2026-10-15. First built inside the consultation repository (tools/beads-ui), then moved here as a standalone command, `beads-explorer`, that runs in any repository using beads (see README). The design review (r1) changed several decisions; they are listed in "Changes after review" at the end and override the sections above where they differ. Asked for by Hassan: a web tool to see and navigate the beads issues and memories, update a status or a description, chat with an AI about one issue, and draw the dependencies.

## Goal and shape

`npm run beads:ui` starts a local web app on `http://127.0.0.1:4410`, then opens the browser. It reads and writes the repository's real beads database by running the `bd` CLI, the only supported interface; it never touches `.beads/` files directly. It is a developer tool: local only, never deployed, and not part of the Astro site or its build.

Why local and not a hosted page: a hosted page cannot reach the local Dolt database or the `bd` binary, so edits would never land in beads.

## Pieces

```
tools/beads-ui/
  server.mjs        Node http server, no dependencies: static files + JSON API + SSE chat
  bd.mjs            the bd bridge: builds argument arrays, runs bd with execFile (no shell), parses JSON
  model.mjs         pure functions: issue normalising, graph building, filtering, ready/blocked, epic progress
  chat.mjs          the AI bridge: runs `claude -p` in stream-json mode, one session per issue
  public/index.html, app.js, styles.css   the UI (plain ES modules, no build step)
tests/tools/beadsUi/*.test.ts            unit tests for bd.mjs argument building, model.mjs, chat.mjs parsing, server validation
```

## Data, all through bd

| Need | Command |
|---|---|
| All issues, including closed | `bd list --all --json --limit 0` (one call; 293 issues today, about 1 MB) |
| One issue, with full dependency rows | `bd show <id> --json` |
| Comments | `bd comments <id> --json`; add: `bd comments add <id> <text>` |
| Memories | `bd memories --json` (a key→text map; skip `schema_version`) |
| Update a memory | `bd remember --key <key> <text>`; delete: `bd forget <key>` |
| Update an issue | `bd update <id>` with `--status`, `--priority`, `--title`, `--description`, `--design`, `--acceptance`, `--notes`, `--assignee`, `--add-label`/`--remove-label` |
| Close or reopen | `bd close <id> --reason <text>`; `bd reopen <id>` |
| Create | `bd create --title … --description … --type … --priority … [--parent …]` |
| Dependencies | add: `bd dep add <issue> <depends-on>`; remove: `bd dep remove <issue> <depends-on>` |

Dependency rows come in two kinds: `parent-child` (263 today) and `blocks` (44). The graph draws both, styled differently.

## API (JSON, 127.0.0.1 only)

- `GET /api/issues` returns `{ issues, fetchedAt }`, with the server's 3 s cache invalidated by any write.
- `GET /api/issues/:id` returns the issue with its comments.
- `PATCH /api/issues/:id` takes allowed fields only (see the table) and returns the updated issue.
- `POST /api/issues/:id/close {reason}`, `POST /api/issues/:id/reopen`, `POST /api/issues/:id/comments {text}`, `POST /api/issues {…}`
- `POST /api/deps {issue, dependsOn}`, `DELETE /api/deps {issue, dependsOn}`
- `GET /api/memories`, `PUT /api/memories/:key {text}`, `DELETE /api/memories/:key`
- `POST /api/chat/:id {message, sessionId?}` returns an SSE stream of `{type:'text', delta}`, `{type:'done', sessionId}` or `{type:'error', message}`.
- `POST /api/sync` runs `bd dolt push` and returns its output; a missing remote is reported plainly.

Safety:
- The server listens on 127.0.0.1 only.
- Each run makes a random token. The page gets it from the server-rendered `index.html`, and every request that is not a GET must send it in `X-Beads-Token`, which also stops cross-site form posts.
- Issue ids must match `^[a-z0-9]+-[a-z0-9.]+$`.
- Memory keys must match `^[a-z0-9][a-z0-9-]{0,80}$`.
- Status and priority are checked against bd's sets.
- Text is capped at 20 000 characters.
- bd always runs through `execFile` with an argument array, never through a shell.
- Writes run one at a time through a queue, so two edits never race in Dolt.

## AI chat about one issue

- **The run:** the server runs the user's own Claude Code CLI with their existing login, so no API key is stored: `claude -p <message> --output-format stream-json --verbose --include-partial-messages`, plus `--session-id <new uuid>` on the first turn and `--resume <id>` after that.
- **Read-only tools:** `--allowedTools "Read,Grep,Glob,Bash(bd show:*),Bash(bd list:*),Bash(bd comments:*),Bash(git log:*),Bash(git show:*)"`, `--disallowedTools "Edit,Write,NotebookEdit"`, and `--permission-mode default`. A non-interactive run denies anything not allowed. The run's working directory is the repo root.
- **System prompt** (`--append-system-prompt`): it gives the issue's id, title, status, description, notes, dependencies and parent. It says the AI may read the repo and beads, and must not change anything. When it recommends a change to the issue, it ends with one fenced block:
  ```beads-update
  {"status":"in_progress","priority":2,"notes":"…","description":"…"}
  ```
  The UI shows that block as a card listing each change, with an Apply button that calls the normal PATCH. **Nothing is applied without a click.**
- **History:** the transcript is kept in the browser's localStorage per issue, with the session id, so a reload keeps the chat. "New chat" starts a fresh session.
- **Cancel:** closing the stream or pressing Stop kills the child process.
- **No CLI:** if `claude` is not on PATH, the chat panel says so and how to install it; everything else still works.

## Screens

The layout is one window. A left rail holds the views and the filters, the centre holds the current view, and a right drawer holds the issue detail.

1. **Board:** columns open, in progress, blocked, deferred and closed (closed collapsed and capped at the latest 50). A card shows the id, title, priority chip, type and labels. Drag a card to another column to change its status: dropping on closed asks for a reason; a drop is keyboard-reachable via the card's status menu.
2. **List:** a sortable table (id, title, status, priority, type, updated, parent) with multi-select and bulk status or priority changes.
3. **Graph:**
   - Edges: `blocks` edges are solid arrows; `parent-child` edges are dashed and can be hidden.
   - Nodes are coloured by status. A ring marks ready issues (open, with no open blocker) and blocked ones.
   - Focus mode shows one issue with N levels of neighbours. "Show the path to done" for an epic draws its open children and their blockers.
   - Layout is dagre, left to right. Pan, zoom, and a click opens the drawer.
4. **Epics:** each epic with a progress bar (closed/total children), its open children, and its ready children.
5. **Memories:** a searchable list of key and text. Edit inline, add, and delete with confirmation. Issue ids written in a memory (`tm-…`) are links.
6. **Insights:**
   - counts by status, priority and type;
   - ready now (the `bd ready` semantics: open, no open `blocks` dependency, not deferred);
   - stale (open, not updated in 14 days);
   - recently closed (7 days);
   - issues for Hassan (title starts "Hassan:" or the assignee is him);
   - P0/P1 open.

**Issue drawer:**
- every field: title, status and priority menus, type, labels, assignee, parent link, dates, and close reason;
- description, design, acceptance and notes as rendered Markdown with an Edit toggle (textarea, Save, Cancel), plus "Append a note";
- dependencies in both directions, with add and remove;
- children;
- comments, with add;
- copy the id;
- "Ask AI" opens the chat tab inside the drawer.

**Everywhere:**
- Search on `/` matches id, title, description, notes and labels.
- Keyboard: `j`/`k` move, `Enter` opens, `Esc` closes, `g b`/`g l`/`g g` switch views.
- Deep links `#/issue/tm-3gs.12` and `#/graph/tm-3gs`.
- The page refreshes data when the window regains focus or every 30 s, and shows "Updated 12 s ago".

UI details:
- Dark and light themes follow the system.
- Markdown is rendered with `marked` and sanitised with `DOMPurify`. Issue text is never put into the DOM unsanitised.
- `cytoscape`, `dagre`, `cytoscape-dagre`, `marked` and `DOMPurify` are loaded from cdnjs/jsDelivr at pinned versions. The tool needs the network for those; this is noted in the README.

## Decisions made without Hassan

1. **Local web app, not a hosted page:** only a local server can reach bd. Cost if wrong: none, since a hosted read-only snapshot can be added later.
2. **The chat uses the Claude Code CLI and the user's login, not an API key:** no secret to store. Cost: the chat needs `claude` installed, which it is on this machine.
3. **The AI is read-only, and its suggestions apply on a click:** no silent edits to beads. Cost: one extra click.
4. **Libraries come from a CDN instead of new npm dependencies:** the site's package-lock stays untouched. Cost: the graph and Markdown need the network.
5. **Port 4410:** it avoids the site (4321), the e2e (4322) and the emulators. `BEADS_UI_PORT` overrides it.

## Tests

- **Unit (Vitest, under tests/tools/beadsUi):**
  - bd argument building for every write (an id, a field set, close with a reason, dep add/remove, remember/forget), with injection-looking text passed as a single argument;
  - the validation refusals;
  - the model's ready and blocked rules against fixture issues (including a closed blocker, which does not block);
  - epic progress;
  - graph nodes and edges from a fixture;
  - stream-json parsing of a recorded `claude -p` output (text deltas, the result event with session_id, an error);
  - extraction of the `beads-update` block, with malformed JSON ignored.
- **Server:** start it on a random port with a fake `bd` (`BEADS_UI_BD` points at a test script) and check:
  - GET issues;
  - a PATCH without the token is refused with 403;
  - a PATCH with the token runs the expected fake-bd arguments;
  - a bad id is refused with 400.
- **Manual (browser):** every view at 1440 and 390 px against the real database, one real status change and its revert, one memory edit and its revert, and one chat turn.

## Later

- Live updates via a bd watch.
- Gantt by due date.
- Saved filters.
- Multiple repos.

## Changes after review (r1)

1. **The AI chat is read-only by construction, not by allow lists.**
   - Each run gets `--tools Read,Grep,Glob`, `--setting-sources ""`, `--strict-mcp-config` and `--permission-mode dontAsk`, plus deny rules for secret files.
   - It has no Bash: the server writes the issue, its links, comments and commits into the prompt, and puts a read-only snapshot of all issues and memories in a temp folder passed with `--add-dir`.
   - The message goes on stdin, and the run's environment drops `CLAUDECODE` and `CLAUDE_CODE_*`.
   - Each run has a 5-minute timeout, a process-group kill, one turn per issue at a time, and a fresh session when `--resume` fails.
   - A real run's start-up report lists the tools as Glob, Grep and Read, with no MCP servers and no plugins.
2. **No DNS rebinding:**
   - Every request must be addressed to `127.0.0.1:<port>` or `localhost:<port>`.
   - Writes must also come from that origin.
   - The token is compared in constant time.
   - OPTIONS gets 405.
3. **No third-party scripts at run time:** the five libraries are vendored under `public/vendor`, and a strict CSP (`script-src 'self'`) is sent. Markdown falls back to plain text if DOMPurify is missing.
4. **Ready and blocked follow `bd ready` exactly,** including blocks carried down from a parent; 101 of 101 matched on the real database. The statuses include pinned and hooked, and the types include spike, story and milestone.
5. **Text that looks like a flag stays text:** every flag value is bound with `=`, positional text follows `--`, and the chat message goes on stdin.
6. **bd calls:**
   - **Writes and conflicts:** all bd calls run through one queue, identical waiting reads are merged, and edits carry `expectedUpdatedAt`. A changed issue gets 409 and the page reloads it.
   - **No `bd show`:** one issue is read with `bd list --id`, because `bd show` rewrites `.beads/last-touched`, which id-less bd commands in other sessions act on.
   - **Bulk changes:** several issues are changed in one `bd update a b c` or `bd close a b c` call.
   - **Close and reopen:** reopen goes through `bd reopen`. Closing an issue with open blockers needs an explicit "close anyway" (bd `--force`).
7. **AI suggestions:**
   - Notes are applied with `--append-notes`, never replacing existing notes.
   - The card shows the current and new value of every text field.
8. **For Hassan** means titles starting "Hassan:" or the label `hassan`. Assignee is not used, since every agent claims as hibrahem.
9. **Sync is hidden** until `bd dolt remote list` shows a remote; today there is none.
10. **No web fonts:** the page uses system fonts, so it makes no network request at all.
