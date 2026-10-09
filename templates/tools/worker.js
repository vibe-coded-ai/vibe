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
// Each @mcp-expose async function becomes a tool your AI can call. Rename the
// record ("note") and its fields to fit what you want your AI to remember.

/**
 * @mcp-expose
 * @description Save a note. Returns the saved note with its id.
 * @param {string} text - The note (required)
 * @param {string} [tag] - Optional tag for grouping, e.g. "idea"
 */
async function add_note(text, tag, env) {
  if (!text || typeof text !== 'string') return { success: false, error: 'text is required' };
  if (tag !== undefined && typeof tag !== 'string') return { success: false, error: 'tag must be a string' };
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const note = { id, text, tag: tag || null, createdAt: now, updatedAt: now };
  await env.VIBE_STORAGE.put(`notes:${id}`, JSON.stringify(note));
  await rememberWrite(env, 'notes:', id);
  return { success: true, data: note };
}

/**
 * @mcp-expose
 * @description List notes, newest first. Optionally only one tag.
 * @param {string} [tag] - Only notes with this tag
 */
async function list_notes(tag, env) {
  if (tag !== undefined && typeof tag !== 'string') return { success: false, error: 'tag must be a string' };
  const notes = await loadAll(env, 'notes:');
  const filtered = tag ? notes.filter((n) => n.tag === tag) : notes;
  filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { success: true, data: filtered };
}

/**
 * @mcp-expose
 * @description Replace the text of an existing note.
 * @param {string} id - Note id (required)
 * @param {string} text - New text (required)
 */
async function update_note(id, text, env) {
  if (!id || typeof id !== 'string') return { success: false, error: 'id is required' };
  if (!text || typeof text !== 'string') return { success: false, error: 'text is required' };
  const stored = await env.VIBE_STORAGE.get(`notes:${id}`);
  if (!stored) return { success: false, error: 'note not found' };
  const note = { ...JSON.parse(stored), text, updatedAt: new Date().toISOString() };
  await env.VIBE_STORAGE.put(`notes:${id}`, JSON.stringify(note));
  await rememberWrite(env, 'notes:', id);
  return { success: true, data: note };
}

/**
 * @mcp-expose
 * @description Delete a note by id. Returns the deleted id.
 * @param {string} id - Note id (required)
 */
async function delete_note(id, env) {
  if (!id || typeof id !== 'string') return { success: false, error: 'id is required' };
  const stored = await env.VIBE_STORAGE.get(`notes:${id}`);
  if (!stored) return { success: false, error: 'note not found' };
  await env.VIBE_STORAGE.delete(`notes:${id}`);
  return { success: true, data: { deleted: id } };
}

// --- Function registry ---

const apiFunctions = {
  add_note: (a, env) => add_note(a.text, a.tag, env),
  list_notes: (a, env) => list_notes(a.tag, env),
  update_note: (a, env) => update_note(a.id, a.text, env),
  delete_note: (a, env) => delete_note(a.id, env),
};

// --- Worker entry point ---

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: corsHeaders });
    }
    const json = (body, status) =>
      new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    try {
      const match = url.pathname.match(/^\/api\/([a-z][a-z0-9_]*)$/);
      if (match && Object.hasOwn(apiFunctions, match[1]) && request.method === 'POST') {
        let args = {};
        try {
          const text = await request.text();
          if (text?.trim()) args = JSON.parse(text);
        } catch {}
        const result = await apiFunctions[match[1]](args, env);
        return json(result, result.success !== false ? 200 : 400);
      }
      return json({ success: false, error: 'Not found' }, 404);
    } catch (error) {
      return json({ success: false, error: error.message }, 500);
    }
  }
};
