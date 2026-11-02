# Platform patterns

## Access and owner checks

New vibes start with visibility private and interaction policy invite_only. Publishing does not change these access settings.
On private vibes, anonymous requests receive 401 before the worker runs, including webhook and cron requests. A host with no build yet answers 404 to everyone (production until the first publish).
Visibility (private, unlisted, public) and interaction policy (public, public_read, authenticated, invite_only) change only on the website.
Through MCP, get_vibe returns the manageUrl to give the owner; through the CLI, vibe settings prints the page.
Check private vibes as the owner with `vibe call` (MCP: `call_tool`) or `vibe fetch` (MCP: `fetch_page`).
MCP clients use worker tools for SQL and files; they do not need a CLI, a local credentials file or vibe files.

The platform answers CORS preflights before the worker; a vibe's page calls its own /api same-origin, while a page on another origin cannot call that API from a browser (server-to-server calls are unaffected).

## Account allowances

`usage` reports account-wide KV, SQL and file storage; SQL includes preview and production databases.
Outbound requests allow 5 per request on Free, 20 on Pro, and 50 on Pro+. The shim keeps an extra slot for storage reporting. Fetch follows redirects; each hop uses one slot of the allowance. EventSource is unavailable; use streaming fetch within the allowance. ID allocation, signed URLs and SQL size reports also use outbound slots. The single storage report waits for in-flight KV/R2/D1 calls and registered `ctx.waitUntil` work for up to 20 seconds after the handler returns, within the runtime request lifetime; a handler that never returns is cut off after 120 seconds. Register background work before returning the response; storage operations started while draining join that report and are booked against the same request. Once reporting closes admission, further storage operations in that request are refused, as they are after a failed report. See `worker-template.md` for a `ctx.waitUntil` example. Re-entering the shim with the author env cannot create fresh outbound capacity; only the private runtime env authenticates a new allowance.
Monthly calls include API calls, builds and storage operations at list price; KV/R2 share 500 units per Free request or 10,000 on Pro/Pro+ (reads 1; writes/lists/deletes 10). Each preview build and each publish counts as about 2,222 calls on Free or 833 on Pro and Pro+ against the monthly allowance. Preview builds also count toward the hourly and daily build caps; publishing does not count toward these build caps.
MCP `usage` returns the plan's call cost for each preview build or publish as `monthlyCalls.buildCallEquivalent`; `vibe status --plan` prints the same cost.
At the monthly allowance, `usage` reports `monthlyCalls.paused: true` and `monthlyCalls.pauseMessage`; its text and `vibe status --plan` name the paused operations, UTC reset date, and how to upgrade or wait. `create_vibe` and `vibe init` include the same warning in their creation notes. Creation still uses a vibe slot; builds remain paused. No pause warning appears under the allowance. An unavailable ledger leaves the status unknown unless the existing budget verdict keeps the account paused.

Measured KV/file/SQL storage pauses worker requests and MCP tools past twice the plan's limit, or past the lowest paid limit for storage the plan does not include; HTTP returns 429 with reason storage_quota.
Owner totals pause all vibes; a SQL database past its pause threshold pauses its environment. At or below that threshold, shim checks refuse writes at the plan cap; reads and deletes work, including after downgrades.
Free space through platform storage APIs or delete an unused vibe; SQL deletion requires a plan with SQL storage. Upgrades recheck immediately.
Hourly checks restore access at or below the pause threshold, plus up to 60 seconds of caching and KV propagation; failed measurements retain the prior verdict. Static assets and file reads keep their usual gates.

## KV (`env.VIBE_STORAGE`, every plan)

Store JSON strings under colon-separated keys (`items:<id>`). `list()` can miss
a key written in the last minute, so "add, then list" needs a small "recent ids"
key merged into the listing. The templates do this:

```javascript
async function rememberWrite(env, prefix, id) {
  const key = `recent:${prefix}`;
  const recent = JSON.parse((await env.VIBE_STORAGE.get(key)) || '[]');
  await env.VIBE_STORAGE.put(key, JSON.stringify([id, ...recent.filter((x) => x !== id)].slice(0, 100)));
}

async function loadAll(env, prefix) {
  const ids = new Set();
  let cursor;
  do { // list() returns at most 1000 keys per page
    const page = await env.VIBE_STORAGE.list({ prefix, cursor });
    for (const k of page.keys) ids.add(k.name.slice(prefix.length));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  for (const id of JSON.parse((await env.VIBE_STORAGE.get(`recent:${prefix}`)) || '[]')) ids.add(id);
  const records = await Promise.all(
    [...ids].map(async (id) => JSON.parse((await env.VIBE_STORAGE.get(`${prefix}${id}`)) || 'null'))
  );
  return records.filter(Boolean); // deleted records drop out
}

// After every put: await rememberWrite(env, 'items:', id);
// To list:         const items = await loadAll(env, 'items:');
```

Need strictly consistent queries? Use SQL.

## SQL (`env.VIBE_D1`, Pro or Pro+)

Preview and production have separate databases; preview starts empty.
On Free, `env.VIBE_D1` is bound but every call throws an error with
`code: 'ENTITLEMENT_EXCEEDED'`, so `if (env.VIBE_D1)` does not detect the plan;
catch that error, or keep Free data in KV.

```javascript
async function _ensureTable(env) {            // call from write paths only; no "done" flag
  await env.VIBE_D1.prepare(`CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`).run();
}

// Write
await _ensureTable(env);
await env.VIBE_D1.prepare('INSERT INTO items (name) VALUES (?)').bind(name).run();

// Read: a read before the first write finds no table, which means empty
let rows;
try {
  rows = (await env.VIBE_D1.prepare('SELECT * FROM items ORDER BY created_at DESC').all()).results;
} catch (err) {
  if (/no such table:\s*(?:main\.)?items\b/i.test(String(err?.message))) rows = [];
  else throw err;
}
```

Use `.prepare(...).run()` / `.all()`, `.first()` or `.batch()` for SQL; hosted `.raw()` and `.exec()` are refused because they omit billing metadata; missing write counts charge 500 Free / 10,000 paid rows per statement.

Through MCP, use call_tool to exercise the worker's SQL tools as the owner.
For a query the worker does not expose, add an @mcp-expose tool, push_source
(it waits for the build), then call_tool (preview by default; production: true
uses the published build).

### CLI only: direct SQL

For terminal users with local CLI login credentials (to check or fix live data), the owner can call
`POST https://api.vibe-coded.ai/api/v1/vibes/<user>/<slug>/d1` with the CLI's
login token (deploy scope is accepted). Use the API URL stored with that token.
It works on the production database, not preview.

```bash
# The token goes in through stdin (curl -K -), so it never shows up in `ps`.
credentials="$HOME/.vibe-coded/credentials.json"
api_url=$(jq -er '.apiUrl | strings | select(length > 0)' "$credentials") || exit 1
user_slug=$(jq -er '.userSlug | strings | select(length > 0)' "$credentials") || exit 1
vibe_slug="your-vibe-slug" # Replace with your vibe's slug.
jq -er '.token | strings | select(length > 0) | "header = \"Authorization: Bearer \(.)\""' "$credentials" |
  curl -sS -K - -X POST "${api_url}/api/v1/vibes/${user_slug}/${vibe_slug}/d1" \
    -H 'Content-Type: application/json' \
    -d '{"action":"query","sql":"SELECT * FROM items WHERE name = ?","params":["a"]}'
```

If it returns `Authentication required`, run `vibe login` (CLI only), then rerun the recipe
with the refreshed credentials. Never paste the token into output.

`action` is `tables`, `query` (SELECT), `execute` (INSERT/UPDATE/DELETE),
`schema` or `usage`. One statement per request, values as `?` with `params`,
no subqueries or `WITH`. Vibes on the older shared database name tables
`vibe_<id>_<table>` in raw SQL (`id` from `GET /api/v1/vibes/<user>/<slug>`);
`tables` lists the short names.

## Files (`env.VIBE_R2`, Pro or Pro+)

On Free, `env.VIBE_R2` is undefined; a worker that may run on Free checks it before use.

Static/source uploads accept only web asset extensions (html, htm, css, js, mjs, ts/tsx/jsx, vue, svelte, json/xml/yaml/yml/toml/csv/tsv, images, fonts, md/txt/pdf, gitignore/npmrc/nvmrc, lock/map) and named extensionless project files; any other file type goes to R2 and is served from `/files/<key>`.

In the worker:

```javascript
await env.VIBE_R2.put('uploads/logo.png', bytes, { httpMetadata: { contentType: 'image/png' } });
const obj = await env.VIBE_R2.get('uploads/logo.png');
const metadata = await env.VIBE_R2.head('uploads/logo.png');
const { objects } = await env.VIBE_R2.list({ prefix: 'uploads/' });
await env.VIBE_R2.delete('uploads/logo.png');
```

**Serving:** every stored object is reachable at `/files/<key>` on the vibe's
own origin, under the vibe's visibility and interaction settings, so an
`<img src="/files/uploads/logo.png">` or `<video src="/files/clips/intro.mp4">`
just works and the browser can seek (range requests) and cache. Images, audio,
video, PDFs, plain text and fonts display inline; anything else is a download
(HTML, SVG and XML as plain text). Preview and production have separate files.
`/files/` is reserved on every vibe, Free included: the platform answers it (a
key with nothing stored is 404 `File not found`), so a `files/` folder in the
project is never served. Each read counts as a request against the vibe's daily
and monthly limits.

**Uploading from the browser:** large uploads go straight to R2 with a signed
URL the worker mints:

```javascript
// Worker tool
async function upload_url(key, contentType, contentLength, env) {
  return { success: true, data: await env.VIBE_R2.createUploadUrl(key, { contentType, contentLength, ttl: 300 }) };
}
// Frontend: get the URL, PUT the file to it, then show it from /files/<key>
```

`createUploadUrl` returns `{ url, expiresAt }`. `contentLength` (the exact byte
size) is required: the signed PUT pins the byte size, not the Content-Type. A
client can store any type under the key, so a worker that cares checks the first
bytes; `/files/<key>` serves scriptable types as plain text regardless. The worker
decides who may upload and to which key.
A 403 SignatureDoesNotMatch on the PUT means the bytes sent differ from contentLength.
The browser's PUT to the signed URL is CORS-allowed from the vibe's own origin (preflight answers 204); no CORS setup is needed.

**Downloading outside the page** (a script, another server): the worker
mints `createDownloadUrl(key)`; the URL lasts at most 120 seconds, so mint one
per request and never store or share it. A page does not need this: use
`/files/<key>`.

Through MCP, expose file operations as worker tools and
invoke them with call_tool. For an operation the worker does not expose, add an
@mcp-expose tool, push_source (it waits for the build), then call_tool.

### CLI only: file commands

From a terminal with the CLI installed and signed in, use `vibe files upload|download|ls|rm|url` (alias `vibe r2`) (MCP: expose a worker tool and invoke it with call_tool).
These default to production's files; add `--preview` for the preview tree.
The preview host serves the preview tree and the production host the production tree; upload to both when a page needs the file in both.
`vibe files usage` (MCP: get_vibe's `r2BytesUsed`) reports file storage across both trees; account `usage` reports KV, SQL and file storage.
Signed uploads count at once; files the worker writes with `put()` count within the hour.

**Check a private vibe with curl:** the token in `~/.vibe-coded/credentials.json`
works on the vibe host as `Authorization: Bearer <token>`, the same as the API.
POST to `/api/<tool>` works the same way. `vibe fetch --headers /files/<key>` (MCP: fetch_page returns headers)
shows how a file is served.

## MCP tool annotations

```javascript
/**
 * @mcp-expose
 * @description Create a bookmark
 * @param {string} url - The URL to bookmark
 * @param {string} [title] - Optional title
 * @param {?number} rating - Rating 1-5, or null
 */
async function create_bookmark(url, title, rating, env) { /* ... */ }
```

- `@mcp-expose` alone makes the function a tool; get_vibe through MCP or
  `vibe status` through the CLI shows the count. Put `env` last in its parameters.
- `[name]` marks an optional parameter; types are `string`, `number`, `boolean`,
  `object`, `array`.
- The platform decides who can write; annotations don't control access.

## Endpoints for machines (webhooks, cron)

For people, rely on the vibe's visibility, interaction and invites.
MCP tool calls pass the same gate, so a tool needs no password or token argument; one would land in the client's call log.
For anonymous webhooks or cron, the owner must choose public or unlisted visibility and public interaction on the website, then protect the endpoint with a dedicated secret.
A worker token cannot bypass the platform's access gate. Gate the endpoint with
the token stored as a secret, sent in an
`X-Webhook-Token` header. Authorization and Cookie never reach your worker;
provider signature headers (Stripe, Svix…) and any `X-Webhook-*` header do.

```javascript
// Create SYNC_TOKEN with set_secret through MCP or vibe secrets create through the CLI.
function _checkToken(request, env) {
  const expected = env.SYNC_TOKEN;
  if (!expected) return false;                 // fail closed if unset
  const got = request.headers.get('X-Webhook-Token') || '';
  if (got.length !== expected.length) return false;
  let diff = 0;                                // constant-time compare
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
```

Use a dedicated secret (not the user's CLI token), and never echo it in responses
or logs. Keys the worker calls out with (Stripe, OpenAI) are also secrets, read
as `env.NAME`.

### Webhook inbox recipe

1. Add a root worker route for `POST /webhooks/inbox`, outside `/api`. Check
   `_checkToken(request, env)` above before storing the payload or making outbound
   calls; reject a missing or invalid token before any side effect.
2. Create `SYNC_TOKEN` with MCP `set_secret` or CLI `vibe secrets create SYNC_TOKEN`.
   Have the sender supply that dedicated secret in `X-Webhook-Token`.
3. Build with MCP `push_source` or CLI `vibe preview`. Probe the route as the owner
   with MCP `fetch_page` (`method: "POST"`, `headers`, `body`) or CLI
   `vibe fetch /webhooks/inbox --preview --method POST --header 'X-Webhook-Token: <dedicated secret>' --data '<payload>'`.
   An owner probe does not prove anonymous access.
4. **Website step:** give the owner `get_vibe`'s `manageUrl` (CLI: `vibe settings`).
   For a public webhook inbox that stores messages, the owner chooses public or
   unlisted visibility and public interaction on that page. Neither MCP nor the
   CLI changes these settings; publishing does not change them either.
5. Publish with MCP `publish` or CLI `vibe publish`, then verify an anonymous
   server-to-server POST with the dedicated header. Preview data does not carry
   to production; check the stored message in production.

For a user vibe with public or unlisted visibility, an anonymous POST to this
non-`/api` route has the following capabilities:

| Interaction policy | Anonymous `POST /webhooks/inbox` |
|---|---|
| `public` | Reaches the worker with storage writes and secrets. |
| `authenticated` | Also reaches this non-`/api` route with storage writes and secrets; sign-in is required on `/api` routes. |
| `public_read` | Reaches the worker in read mode: storage writes are refused and secrets are hidden. Outbound fetches still run. |
| `invite_only` | Receives 401 before the worker runs. |

Private visibility returns 401 for anonymous requests under every interaction
policy. A webhook token cannot grant storage writes or reveal secrets in read
mode. Always verify the token before side effects; `authenticated` alone does
not authenticate an anonymous caller to a non-`/api` route.

## URLs

- Preview: `p--{userSlug}--{vibeSlug}.vibe-coded.ai`
- Production: `{userSlug}--{vibeSlug}.vibe-coded.ai`
