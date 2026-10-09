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
 * @description Append a dated entry to the journal
 * @param {string} title - Entry title (required)
 * @param {string} notes - Freeform notes and observations (required)
 * @param {string} [date] - The user's local date, YYYY-MM-DD (pass it; falls back to UTC today)
 * @param {number} [hydrationPct] - Dough hydration percentage
 * @param {string} [flour] - Flour or flour blend used
 * @param {number} [rating] - Rating from 1 to 5
 * @param {string} [outcome] - Short description of the outcome
 */
async function log_entry(title, notes, date, hydrationPct, flour, rating, outcome, env) {
  if (!title || typeof title !== 'string') {
    return { success: false, error: 'title is required' };
  }
  if (typeof notes !== 'string') {
    return { success: false, error: 'notes is required' };
  }
  // Strict YYYY-MM-DD: entries sort by this string, so '2026-09-9' must not get
  // in, nor a date the calendar doesn't have ('2026-02-31' parses, as March 3).
  if (date !== undefined && (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
      || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) {
    return { success: false, error: 'date must be YYYY-MM-DD' };
  }
  if (hydrationPct !== undefined && (typeof hydrationPct !== 'number' || !Number.isFinite(hydrationPct))) {
    return { success: false, error: 'hydrationPct must be a number' };
  }
  if (flour !== undefined && typeof flour !== 'string') {
    return { success: false, error: 'flour must be a string' };
  }
  if (rating !== undefined && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
    return { success: false, error: 'rating must be an integer from 1 to 5' };
  }
  if (outcome !== undefined && typeof outcome !== 'string') {
    return { success: false, error: 'outcome must be a string' };
  }

  const createdAt = new Date().toISOString();
  const id = crypto.randomUUID();
  const entry = {
    id,
    title,
    date: date || createdAt.slice(0, 10),
    notes,
    hydrationPct: hydrationPct ?? null,
    flour: flour || '',
    rating: rating ?? null,
    outcome: outcome || '',
    createdAt
  };
  await env.VIBE_STORAGE.put(`entries:${id}`, JSON.stringify(entry));
  await rememberWrite(env, 'entries:', id);
  return { success: true, data: entry };
}

/**
 * @mcp-expose
 * @mcp-scope read
 * @description List journal entries with the most recent first
 * @param {number} [limit] - Maximum entries to return (defaults to 50, max 100)
 */
async function list_entries(limit, env) {
  const resultLimit = limit === undefined ? 50 : limit;
  if (!Number.isInteger(resultLimit) || resultLimit < 1 || resultLimit > 100) {
    return { success: false, error: 'limit must be an integer from 1 to 100' };
  }

  const entries = await loadAll(env, 'entries:');
  entries.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  return { success: true, data: entries.slice(0, resultLimit) };
}

/**
 * @mcp-expose
 * @mcp-scope read
 * @description Get one journal entry by ID
 * @param {string} id - Entry ID (required)
 */
async function get_entry(id, env) {
  if (!id || typeof id !== 'string') {
    return { success: false, error: 'id is required' };
  }
  const stored = await env.VIBE_STORAGE.get(`entries:${id}`);
  if (!stored) {
    return { success: false, error: 'entry not found' };
  }
  return { success: true, data: JSON.parse(stored) };
}

/**
 * @mcp-expose
 * @mcp-scope read
 * @description Search journal entry titles, notes, and flour
 * @param {string} query - Case-insensitive substring to find (required)
 */
async function search_entries(query, env) {
  if (!query || typeof query !== 'string') {
    return { success: false, error: 'query is required' };
  }
  const needle = query.toLowerCase();
  const entries = await loadAll(env, 'entries:');
  const matches = entries.filter((entry) =>
    [entry.title, entry.notes, entry.flour].some((value) =>
      String(value || '').toLowerCase().includes(needle)
    )
  );
  matches.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  return { success: true, data: matches };
}

/**
 * @mcp-expose
 * @mcp-scope write
 * @description Delete one journal entry by ID. Returns the deleted ID.
 * @param {string} id - Entry ID (required)
 */
async function delete_entry(id, env) {
  if (!id || typeof id !== 'string') {
    return { success: false, error: 'id is required' };
  }
  const stored = await env.VIBE_STORAGE.get(`entries:${id}`);
  if (!stored) {
    return { success: false, error: 'entry not found' };
  }
  await env.VIBE_STORAGE.delete(`entries:${id}`);
  await forgetWrite(env, 'entries:', id);
  return { success: true, data: { deleted: id } };
}

// --- Function registry ---

const apiFunctions = {
  'log_entry': log_entry,
  'list_entries': list_entries,
  'get_entry': get_entry,
  'search_entries': search_entries,
  'delete_entry': delete_entry,
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
          case 'log_entry':
            result = await log_entry(args.title, args.notes, args.date, args.hydrationPct, args.flour, args.rating, args.outcome, env);
            break;
          case 'list_entries':
            result = await list_entries(args.limit, env);
            break;
          case 'get_entry':
            result = await get_entry(args.id, env);
            break;
          case 'search_entries':
            result = await search_entries(args.query, env);
            break;
          case 'delete_entry':
            result = await delete_entry(args.id, env);
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
