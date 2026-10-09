# Platform patterns

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

## SQL (`env.VIBE_D1`, needs Pro)

Preview and production have separate databases; preview starts empty.

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

Use `.prepare(...).run()` / `.all()`, not `.exec()`.

**Running SQL by hand** (to check or fix live data): the owner can call
`POST https://api.vibe-coded.ai/api/v1/vibes/<user>/<slug>/d1` with the CLI's
login token. It works on the production database, not preview.

```bash
# The token goes in through stdin (curl -K -), so it never shows up in `ps`.
printf 'header = "Authorization: Bearer %s"\n' "$(jq -r .token ~/.vibe-coded/credentials.json)" |
  curl -s -K - -X POST https://api.vibe-coded.ai/api/v1/vibes/<user>/<slug>/d1 \
    -H 'Content-Type: application/json' \
    -d '{"action":"query","sql":"SELECT * FROM items WHERE name = ?","params":["a"]}'
```

`action` is `tables`, `query` (SELECT), `execute` (INSERT/UPDATE/DELETE),
`schema` or `usage`. One statement per request, values as `?` with `params`,
no subqueries or `WITH`. Vibes on the older shared database name tables
`vibe_<id>_<table>` in raw SQL (`id` from `GET /api/v1/vibes/<user>/<slug>`);
`tables` lists the short names.

## Files (`env.VIBE_R2`, needs Pro)

In the worker:

```javascript
await env.VIBE_R2.put('uploads/logo.png', bytes, { httpMetadata: { contentType: 'image/png' } });
const obj = await env.VIBE_R2.get('uploads/logo.png');
const { objects } = await env.VIBE_R2.list({ prefix: 'uploads/' });
await env.VIBE_R2.delete('uploads/logo.png');
```

Large browser uploads go straight to R2 with a signed URL the worker mints:

```javascript
// Worker tool
async function upload_url(key, contentType, contentLength, env) {
  return { success: true, data: await env.VIBE_R2.createUploadUrl(key, { contentType, contentLength, ttl: 300 }) };
}
// Frontend: get the URL, then PUT the file to it
```

`contentLength` (the exact byte size) is required. Download URLs
(`createDownloadUrl(key)`) last at most 120 seconds: mint one per request and
never store or share it. From a terminal, use `vibe r2 upload|download|ls|rm|url`.

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

- `@mcp-expose` alone makes the function a tool; `vibe status` shows the count.
- `[name]` marks an optional parameter; types are `string`, `number`, `boolean`,
  `object`, `array`.
- The platform decides who can write; annotations don't control access.

## Endpoints for machines (webhooks, cron)

For people, rely on the vibe's visibility, interaction and invites. For a system
that can't sign in, gate one endpoint with a token stored as a secret, sent in an
`X-Webhook-Token` header. Authorization and Cookie never reach your worker;
provider signature headers (Stripe, GitHub, Svix…) and any `X-Webhook-*` header do.

```javascript
// vibe secrets create SYNC_TOKEN
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

## URLs

- Preview: `p--{userSlug}--{vibeSlug}.vibe-coded.ai`
- Production: `{userSlug}--{vibeSlug}.vibe-coded.ai`
