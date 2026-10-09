---
name: vibe-coded-ai
version: 4.5.6
description: Build, host, and connect vibes on vibe-coded.ai from your coding agent — data stores your AI reads and writes through MCP tools, or static and Vue web apps. Covers the whole lifecycle — scaffold, run locally, preview, publish, connect an AI client — plus settings, access, and secrets.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - WebFetch
  - AskUserQuestion
arguments:
  - name: action
    description: "Action: login, init, templates, dev, preview, publish, status, fetch, call, connect, urls, logs, settings, access, secrets, r2, delete (deploy is alias for preview)"
    required: false
  - name: slug
    description: "Vibe slug (used with most actions)"
    required: false
---

# vibe-coded.ai — build, host, and connect vibes

You are helping someone build a **vibe**: an app hosted at
`{userSlug}--{vibeSlug}.vibe-coded.ai` with its own storage and, usually, MCP tools
their AI can call.

**CLI:** run `~/.claude/skills/vibe-coded-ai/bin/vibe <action>` with Bash (the
installer also puts `vibe` on PATH). If a command says you're not signed in, run
`login`. CLI errors are plain sentences: read them and do what they say. When a
change is web-only, the CLI prints a link; give it to the user.

## 1. Pick the path

Ask (with `AskUserQuestion`) only if the request doesn't make it obvious:

| If the user wants… | Path | Start with |
|---|---|---|
| Something their AI can **remember, look up, or update** (a tracker, log, journal, notes) | **A. Your AI's data** (default) | `vibe init --template tools <slug>` (KV, every plan) or `--template tools-sql` (SQL, needs Pro); closer starting points: `tracker`, `log`, `journal` |
| A **page or site** with no data | **B. Site** | `vibe init --template site <slug>` |
| A **web app with a build step** (Vue) | **B. Web app** | `vibe init <slug>`, then the files in `references/vue-template.md` |
| To **host a project that already exists** | **C. Existing app** | `vibe init <slug>` in the project folder |

`vibe templates` lists every template; prefer one over hand-written files.
`vibe status --plan` shows the plan (SQL, R2 and secrets need Pro).

## 2. Path A — your AI's data

1. **Scaffold:** `vibe init --template tools <slug>` in an empty folder. New vibes
   are private: only the owner and people they invite can use them.
2. **Model the data, then the tools** (see *Designing tools*).
3. **Run locally:** `vibe dev`, then exercise every tool with curl
   (`POST /api/<tool>` or `/mcp`). Fix before deploying.
4. **Preview:** `vibe preview`. Check the reported tool count.
5. **Publish:** `vibe publish`.
6. **Prove it works — required.** `vibe call` calls a tool on the live vibe as the
   owner. Create a uniquely named record, read it back, then delete it by its `id`:
   ```bash
   TEST=$(vibe call add_x '{"name":"vibe verification test"}')
   ID=$(printf '%s' "$TEST" | jq -r '.data.id')
   vibe call list_x
   vibe call delete_x "{\"id\":\"$ID\"}"
   ```
7. **Connect the user's AI.**
   - **Claude Code:** run `vibe connect` yourself. It adds the vibe as an MCP
     server and prints `Check: ✔ Connected`. The tools load in the next session.
   - **claude.ai / Claude Desktop:** Settings → Connectors → Add custom connector →
     `https://{userSlug}--{vibeSlug}.vibe-coded.ai/mcp`. The user signs in in their
     browser, so hand this step over.
   - **Other MCP clients:** the same URL, with OAuth sign-in.

   Give the user a first prompt that uses the vibe's tools ("log a 5-mile run, then
   show this week's total"). You're done when `vibe call` works and the user's AI is
   connected or has the connector steps.

### Designing tools

- **Record first.** Write down the fields before any code.
- **One tool per thing the user will say:** `add_x`, `list_x` (with the filters
  they'll use), `get_x`, `update_x`, and a narrow `delete_x(id)` so verification can
  clean up. Skip tools nobody will ask for.
- **Descriptions are for the AI.** `@description` and `@param` are what it reads;
  say what the tool does and give example values. Nullable params: `{?number}`.
- **Return what the next step needs:** writes return the saved record with its
  `id`; lists return newest first; errors are `{ success: false, error }` with a
  sentence the AI can act on.
- **Dates:** the worker runs in UTC. For records that belong to a day, take a
  `date` parameter (`YYYY-MM-DD`, the user's local date) and fall back to UTC today.
- **Don't build auth into tools.** The platform decides who can read and who can
  write (see *Who can use a vibe*).

## 3. Path B — a site or a web app

- **Site:** `vibe init --template site <slug>`, edit `index.html`, `vibe preview`,
  check it with `vibe fetch / --preview`, then `vibe publish`.
- **Web app (Vue/Vite):** `vibe init <slug>`, write the files from
  `references/vue-template.md`, and add a root `worker.ts` from
  `references/worker-template.md` if it needs a backend. `vibe dev` runs the worker
  only; use `npx vite` for the UI or check it on preview.

## 4. Path C — bring an existing app

1. **Survey first:** find the frontend, the backend entry, its storage and secrets,
   and read the backend's imports.
2. **Register in place:** `vibe init <slug>` (no template) leaves your files alone.
3. **Backend → one root worker:** `./worker.js` or `./worker.ts` exporting
   `{ async fetch(request, env) }` (`references/worker-template.md`). Requests
   that don't match a static file go to the worker with their method (except the
   paths of its source files and root project files such as `package.json` or
   `README.md`), so keep the app's existing routes and methods. npm packages that
   run on Cloudflare Workers are fine. Node-only code is not: `fs`, `child_process`, native
   addons, Express and other servers. Rewrite handlers against `Request`/`Response`.
   There is no filesystem and no long-running process.
4. **Swap the storage:** files or a local database become `env.VIBE_STORAGE`,
   `env.VIBE_D1` or `env.VIBE_R2`; `.env` values become `vibe secrets` (locally,
   `.dev.vars`).
5. **Frontend:** static files move as they are; a Vite app builds to `dist/`.
6. **Keep only what you mean to publish** in the folder (next section).
7. Add `@mcp-expose` tools if useful, then `vibe dev`, `vibe preview`, `vibe call`,
   `vibe publish`.

## 5. What gets uploaded and served

`vibe preview` uploads the project folder, minus dependencies, build output, git,
local secret files (`.env*`, `.dev.vars`) and agent/editor folders. If the project
has a build step (a `build` script in `package.json`) and it writes `dist/`, only
`dist/` is served. Otherwise, uploaded files are readable at their paths by anyone
who can open the vibe. `vibe preview` lists what it uploaded and what is readable.

Preview has its own data, separate from production, and starts empty. Publishing
doesn't copy data across. Outbound calls (email, webhooks) are real in preview too.

## 6. Who can use a vibe

Two settings, both changed on the web (the CLI prints the link):

- **Visibility** — `private`, `unlisted` or `public`: who can see it.
- **Interaction** — who can use it. A private vibe is always owner-and-invited
  only; on a public or unlisted vibe:
  - `invite_only`: only the owner and people they grant.
  - `public_read`: anyone can read; only the owner and invited writers can change
    data. Use this (with `public` visibility) for a public read-only server.
  - `authenticated`: any signed-in account can read, and write through `/api`.
  - `public`: any visitor can read, and write through `/api`.

  Uninvited callers are always read-only over MCP; MCP writes need an owner,
  writer or admin.

Read-only callers can't write storage or see secrets, but outbound fetches still
run, so guard email and webhooks yourself. Roles for invited people: `viewer`
(read), `writer` (read and write), `admin`; only the owner manages access and
settings. To use a vibe someone shared with you, run `vibe connect <owner>/<slug>`.

## 7. Commands

| Command | What it does |
|---|---|
| `login` | Sign in (browser flow, below) |
| `logout` | Remove local credentials |
| `init [--template T] <slug>` | Create a vibe and write `.vibe-coded.json`; `--adopt` reuses your existing slug |
| `templates` | List templates |
| `dev [--port N] [--reset]` | Run locally on `127.0.0.1:8787` with local KV, SQL and R2; `dev seed file.sql` loads local SQL |
| `preview` | Upload, build, and deploy to the preview URL |
| `publish` | Promote the preview to production |
| `call <tool> ['{json}'] [--preview]` | Call one tool on the live vibe as the owner |
| `fetch <path> [--preview]` | Fetch a deployed page or file as the owner |
| `connect [<owner>/<slug>] [--revoke]` | Connect Claude Code to a vibe (yours or one shared with you) |
| `status [--plan]` | Live builds, tool counts, and plan (`--plan` also shows this month's usage against the plan's budget); upgrades are at vibe-coded.ai/billing |
| `logs [build-id]` | Build logs |
| `urls` | Preview, production and MCP URLs |
| `settings [--title T]` | View settings, change the title; visibility and interaction are web-only |
| `access list` | List collaborators; grants and revokes are web-only |
| `secrets list\|create\|update\|delete NAME` | Write-only secrets (Pro), read in the worker as `env.NAME` |
| `r2 upload\|download\|ls\|rm\|url` | Files in production R2 (Pro) |
| `delete` | Prints the web link to delete the vibe |

**Login:** run `vibe login --start`; it prints a link and a code. Give both to the
user, ask them to approve in the browser, then run `vibe login --finish`. It works
for Google and GitHub accounts too. A person at a terminal can just run
`vibe login`.

**Secrets** are read with `read -s`, so values never enter the conversation. Never
ask the user to paste one into chat.

**`vibe dev` vs production:** locally there are no access checks, R2 signed URLs
don't work, and `/mcp` supports only `initialize`, `tools/list` and `tools/call`.
Check those on preview. Local secrets go in `.dev.vars`.

## 8. Writing worker code

Details and examples (including running SQL against a live vibe):
`references/platform-patterns.md`, `references/worker-template.md`.

| Binding | Storage | Plan |
|---|---|---|
| `env.VIBE_STORAGE` | KV: `.get` `.put` `.delete` `.list({prefix})` | every plan |
| `env.VIBE_D1` | SQL (D1): `.prepare(sql).bind(...).run()` / `.all()` | Pro or Pro+ |
| `env.VIBE_R2` | Files (R2): `.put` `.get` `.delete` `.list`; `createUploadUrl(key, {contentLength, contentType})` for browser uploads | Pro or Pro+ |

- **`@mcp-expose`** on an `async function` makes it an MCP tool, served at
  `POST /api/<tool_name>`. Function names are snake_case; `env` is the last
  parameter.
- Worker responses are `{ success: true, data }` or `{ success: false, error }`.
- The frontend calls the worker with relative `/api/` paths, never absolute URLs.
- Create SQL tables in code (`CREATE TABLE IF NOT EXISTS`); preview starts empty.
- **KV `list()` lags new writes by up to a minute.** Don't build a list tool on
  `list()` alone; use the pattern in `references/platform-patterns.md` (the
  templates do), or use SQL.
- Files and images go in R2, not base64 in KV.
- Vue: use `createWebHashHistory()`, and keep `vite` in `devDependencies`.
- Use one root worker: `worker.ts` or `worker.js`, not both, and not `src/worker.*`.

## 9. Trust

The CLI token in `~/.vibe-coded/credentials.json` can build and publish but can't
read secrets, change access or visibility, or delete vibes. Treat it like an SSH
key. Install the skill only from `curl -fsSL https://vibe-coded.ai/install.sh | sh`.
