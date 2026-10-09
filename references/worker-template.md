# Worker template

The full, tested workers ship with the CLI templates. Copy the one that fits:

- KV (every plan): `templates/tools/worker.js` in this skill folder
- SQL (needs Pro): `templates/tools-sql/worker.js`

Or scaffold one with `vibe init --template tools <slug>` / `--template tools-sql`.

## Shape

```javascript
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

/**
 * @mcp-expose
 * @description Save an item. Returns the saved item with its id.
 * @param {string} name - Item name (required)
 */
async function add_item(name, env) {
  if (!name || typeof name !== 'string') return { success: false, error: 'name is required' };
  const item = { id: crypto.randomUUID(), name, createdAt: new Date().toISOString() };
  await env.VIBE_STORAGE.put(`items:${item.id}`, JSON.stringify(item));
  return { success: true, data: item };
}

// Map each tool to its arguments
const apiFunctions = {
  add_item: (a, env) => add_item(a.name, env),
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    const json = (body, status) =>
      new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    try {
      const match = new URL(request.url).pathname.match(/^\/api\/([a-z][a-z0-9_]*)$/);
      if (match && Object.hasOwn(apiFunctions, match[1]) && request.method === 'POST') {
        let args = {};
        try { const text = await request.text(); if (text.trim()) args = JSON.parse(text); } catch {}
        const result = await apiFunctions[match[1]](args, env);
        return json(result, result.success !== false ? 200 : 400);
      }
      return json({ success: false, error: 'Not found' }, 404);
    } catch (error) {
      return json({ success: false, error: error.message }, 500);
    }
  }
};
```

## Rules

- One root file, `./worker.js` or `./worker.ts`. Local modules and npm packages
  that run on Cloudflare Workers are fine; Node-only modules (`fs`,
  `child_process`, `net`) are not.
- Tool functions are snake_case `async function`s with `env` as the last
  parameter, and every tool has an entry in `apiFunctions`.
- Return `{ success: true, data }` or `{ success: false, error }`.
- Tools are called as `POST /api/<tool_name>`. Any other request that doesn't match
  a static file reaches the worker too, so routes like `GET /api/items` or `/healthz` work
  (not the paths of the worker's source files or of root files such as `package.json`).
- SQL: create tables from write paths (`CREATE TABLE IF NOT EXISTS`), and treat
  "no such table" on a read as empty; preview starts with an empty database.
- KV: use the `rememberWrite` / `loadAll` helpers from the template for lists
  (see `platform-patterns.md`).
