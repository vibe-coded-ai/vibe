const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

// --- Storage helpers ---
//
// KV list() is eventually consistent: a key written moments ago can be missing
// from it for up to a minute. Every write also records its id in one small
// "recent" key. get() normally sees a write made moments earlier from the same
// location (Cloudflare doesn't promise it across locations), and reads merge
// the two, so a record usually shows up in the very next list call; list()
// itself catches up within the minute either way.
// Two writes at the same instant can drop one id from "recent" (KV has no
// compare-and-swap); that record then appears once list() catches up — never
// worse than list() alone.
const RECENT_MAX = 100;

async function rememberWrite(env, prefix, id) {
  const key = `recent:${prefix}`;
  const recent = JSON.parse((await env.VIBE_STORAGE.get(key)) || '[]');
  const next = [id, ...recent.filter((x) => x !== id)].slice(0, RECENT_MAX);
  await env.VIBE_STORAGE.put(key, JSON.stringify(next));
}

async function forgetWrite(env, prefix, id) {
  const key = `recent:${prefix}`;
  const recent = JSON.parse((await env.VIBE_STORAGE.get(key)) || '[]');
  if (recent.includes(id)) await env.VIBE_STORAGE.put(key, JSON.stringify(recent.filter((x) => x !== id)));
}

async function loadAll(env, prefix) {
  const ids = new Set();
  let cursor;
  do { // list() returns at most 1000 keys per page
    const page = await env.VIBE_STORAGE.list({ prefix, cursor });
    for (const k of page.keys) ids.add(k.name.slice(prefix.length));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const recentRaw = await env.VIBE_STORAGE.get(`recent:${prefix}`);
  for (const id of JSON.parse(recentRaw || '[]')) ids.add(id);
  const records = await Promise.all(
    [...ids].map(async (id) => JSON.parse((await env.VIBE_STORAGE.get(`${prefix}${id}`)) || 'null'))
  );
  return records.filter(Boolean);
}

// --- MCP-exposed API functions ---

// The values the page offers. Tools reject anything else, so a status the page
// can't show or filter never gets stored. Change both lists here and in index.html.
const STATUSES = ['open', 'in progress', 'blocked', 'done'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

/**
 * @mcp-expose
 * @mcp-scope write
 * @description Add an item to the status tracker
 * @param {string} name - Item name (required)
 * @param {string} [status] - Initial status: open, in progress, blocked or done (defaults to open)
 * @param {string} [notes] - Notes about the item
 * @param {string} [priority] - Priority: low, normal, high or urgent (defaults to normal)
 */
async function add_item(name, status = 'open', notes = '', priority = 'normal', env) {
  if (!name || typeof name !== 'string') {
    return { success: false, error: 'name is required' };
  }
  if (!STATUSES.includes(status)) {
    return { success: false, error: `status must be one of: ${STATUSES.join(', ')}` };
  }
  if (typeof notes !== 'string') {
    return { success: false, error: 'notes must be a string' };
  }
  if (!PRIORITIES.includes(priority)) {
    return { success: false, error: `priority must be one of: ${PRIORITIES.join(', ')}` };
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const item = { id, name, status, notes, priority, createdAt, updatedAt: createdAt };
  await env.VIBE_STORAGE.put(`items:${id}`, JSON.stringify(item));
  await rememberWrite(env, 'items:', id);
  return { success: true, data: item };
}

/**
 * @mcp-expose
 * @mcp-scope write
 * @description Update the status of an existing tracker item, and optionally its notes
 * @param {string} id - Item ID (required)
 * @param {string} status - New status: open, in progress, blocked or done (required)
 * @param {string} [notes] - Replacement notes; omit to keep the current notes
 */
async function update_status(id, status, notes, env) {
  if (!id || typeof id !== 'string') {
    return { success: false, error: 'id is required' };
  }
  if (!STATUSES.includes(status)) {
    return { success: false, error: `status must be one of: ${STATUSES.join(', ')}` };
  }
  if (notes !== undefined && typeof notes !== 'string') {
    return { success: false, error: 'notes must be text' };
  }
  const stored = await env.VIBE_STORAGE.get(`items:${id}`);
  if (!stored) {
    return { success: false, error: 'item not found' };
  }
  const item = JSON.parse(stored);
  item.status = status;
  if (notes !== undefined) item.notes = notes;
  item.updatedAt = new Date().toISOString();
  await env.VIBE_STORAGE.put(`items:${id}`, JSON.stringify(item));
  await rememberWrite(env, 'items:', id);
  return { success: true, data: item };
}

/**
 * @mcp-expose
 * @mcp-scope read
 * @description List tracker items, optionally filtered by status
 * @param {string} [status] - Only this status: open, in progress, blocked or done
 */
async function list_items(status, env) {
  if (status !== undefined && typeof status !== 'string') {
    return { success: false, error: 'status must be a string' };
  }
  const items = await loadAll(env, 'items:');
  const filtered = status ? items.filter((item) => item.status === status) : items;
  filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { success: true, data: filtered };
}

/**
 * @mcp-expose
 * @mcp-scope read
 * @description Get one tracker item by ID
 * @param {string} id - Item ID (required)
 */
async function get_item(id, env) {
  if (!id || typeof id !== 'string') {
    return { success: false, error: 'id is required' };
  }
  const stored = await env.VIBE_STORAGE.get(`items:${id}`);
  if (!stored) {
    return { success: false, error: 'item not found' };
  }
  return { success: true, data: JSON.parse(stored) };
}

/**
 * @mcp-expose
 * @mcp-scope write
 * @description Delete one tracker item by ID. Returns the deleted ID.
 * @param {string} id - Item ID (required)
 */
async function delete_item(id, env) {
  if (!id || typeof id !== 'string') {
    return { success: false, error: 'id is required' };
  }
  const stored = await env.VIBE_STORAGE.get(`items:${id}`);
  if (!stored) {
    return { success: false, error: 'item not found' };
  }
  await env.VIBE_STORAGE.delete(`items:${id}`);
  await forgetWrite(env, 'items:', id);
  return { success: true, data: { deleted: id } };
}

// --- Function registry ---

const apiFunctions = {
  'add_item': add_item,
  'update_status': update_status,
  'list_items': list_items,
  'get_item': get_item,
  'delete_item': delete_item,
};

// --- Worker entry point ---

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: corsHeaders });
    }

    try {
      // Route /api/{function_name} to MCP functions
      const pathMatch = url.pathname.match(/^\/api\/(.+)$/);
      if (pathMatch && Object.hasOwn(apiFunctions, pathMatch[1]) && request.method === 'POST') {
        let args = {};
        try {
          const text = await request.text();
          if (text?.trim()) args = JSON.parse(text);
        } catch {}

        let result;
        switch (pathMatch[1]) {
          case 'add_item':
            result = await add_item(args.name, args.status, args.notes, args.priority, env);
            break;
          case 'update_status':
            result = await update_status(args.id, args.status, args.notes, env);
            break;
          case 'list_items':
            result = await list_items(args.status, env);
            break;
          case 'get_item':
            result = await get_item(args.id, env);
            break;
          case 'delete_item':
            result = await delete_item(args.id, env);
            break;
          default:
            return new Response(
              JSON.stringify({ success: false, error: 'Unknown endpoint' }),
              { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        return new Response(
          JSON.stringify(result),
          { status: result.success !== false ? 200 : 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({ success: false, error: 'Not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    } catch (error) {
      return new Response(
        JSON.stringify({ success: false, error: error.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  }
};
