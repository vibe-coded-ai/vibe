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

/**
 * @mcp-expose
 * @mcp-scope write
 * @description Append a timestamped event to the log
 * @param {string} message - Event message (required)
 * @param {string[]} [tags] - Tags that categorize the event
 */
async function record(message, tags = [], env) {
  if (!message || typeof message !== 'string') {
    return { success: false, error: 'message is required' };
  }
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) {
    return { success: false, error: 'tags must be an array of strings' };
  }

  const id = crypto.randomUUID();
  const event = { id, message, tags, timestamp: new Date().toISOString() };
  await env.VIBE_STORAGE.put(`events:${id}`, JSON.stringify(event));
  await rememberWrite(env, 'events:', id);
  return { success: true, data: event };
}

/**
 * @mcp-expose
 * @mcp-scope read
 * @description Return the most recent events from the log
 * @param {number} [limit] - Maximum events to return (defaults to 50, max 100)
 */
async function tail(limit, env) {
  const resultLimit = limit === undefined ? 50 : limit;
  if (!Number.isInteger(resultLimit) || resultLimit < 1 || resultLimit > 100) {
    return { success: false, error: 'limit must be an integer from 1 to 100' };
  }
  const events = await loadAll(env, 'events:');
  events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return { success: true, data: events.slice(0, resultLimit) };
}

/**
 * @mcp-expose
 * @mcp-scope read
 * @description Search event messages and tags
 * @param {string} query - Case-insensitive substring to find (required)
 */
async function find(query, env) {
  if (!query || typeof query !== 'string') {
    return { success: false, error: 'query is required' };
  }
  const needle = query.toLowerCase();
  const events = await loadAll(env, 'events:');
  const matches = events.filter((event) =>
    event.message.toLowerCase().includes(needle) ||
    event.tags.some((tag) => tag.toLowerCase().includes(needle))
  );
  matches.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return { success: true, data: matches };
}

/**
 * @mcp-expose
 * @mcp-scope write
 * @description Delete one log event by ID. Returns the deleted ID.
 * @param {string} id - Event ID (required)
 */
async function delete_event(id, env) {
  if (!id || typeof id !== 'string') {
    return { success: false, error: 'id is required' };
  }
  const stored = await env.VIBE_STORAGE.get(`events:${id}`);
  if (!stored) {
    return { success: false, error: 'event not found' };
  }
  await env.VIBE_STORAGE.delete(`events:${id}`);
  await forgetWrite(env, 'events:', id);
  return { success: true, data: { deleted: id } };
}

// --- Function registry ---

const apiFunctions = {
  'record': record,
  'tail': tail,
  'find': find,
  'delete_event': delete_event,
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
          case 'record':
            result = await record(args.message, args.tags, env);
            break;
          case 'tail':
            result = await tail(args.limit, env);
            break;
          case 'find':
            result = await find(args.query, env);
            break;
          case 'delete_event':
            result = await delete_event(args.id, env);
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
