const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

// --- Database setup ---
// Create tables lazily, from write tools only. No "already created" flag:
// for a read-only caller the platform turns this DDL into a no-op, and a flag
// set then would make the owner's next write skip the CREATE and fail.
async function ensureTables(env) {
  await env.VIBE_D1.prepare(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      tag TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();
}

const toNote = (row) => ({ id: row.id, text: row.text, tag: row.tag, createdAt: row.created_at, updatedAt: row.updated_at });

// --- MCP-exposed API functions ---
// Each @mcp-expose async function becomes a tool your AI can call. Rename the
// table and its columns to fit what you want your AI to remember.

/**
 * @mcp-expose
 * @description Save a note. Returns the saved note with its id.
 * @param {string} text - The note (required)
 * @param {string} [tag] - Optional tag for grouping, e.g. "idea"
 */
async function add_note(text, tag, env) {
  if (!text || typeof text !== 'string') return { success: false, error: 'text is required' };
  if (tag !== undefined && typeof tag !== 'string') return { success: false, error: 'tag must be a string' };
  await ensureTables(env);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.VIBE_D1.prepare('INSERT INTO notes (id, text, tag, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, text, tag || null, now, now).run();
  return { success: true, data: { id, text, tag: tag || null, createdAt: now, updatedAt: now } };
}

/**
 * @mcp-expose
 * @description List notes, newest first. Optionally only one tag.
 * @param {string} [tag] - Only notes with this tag
 * @param {number} [limit] - Maximum notes to return (default 100, max 500)
 */
async function list_notes(tag, limit, env) {
  if (tag !== undefined && typeof tag !== 'string') return { success: false, error: 'tag must be a string' };
  const n = Math.min(Math.max(Number.isInteger(limit) ? limit : 100, 1), 500);
  const stmt = tag
    ? env.VIBE_D1.prepare('SELECT * FROM notes WHERE tag = ? ORDER BY created_at DESC LIMIT ?').bind(tag, n)
    : env.VIBE_D1.prepare('SELECT * FROM notes ORDER BY created_at DESC LIMIT ?').bind(n);
  try {
    const { results } = await stmt.all();
    return { success: true, data: results.map(toNote) };
  } catch (err) {
    // A first read may precede the first write that creates this exact table.
    // Do not swallow a different missing-table name: that is usually a SQL typo.
    if (/no such table:\s*(?:main\.)?notes\b/i.test(String(err?.message))) return { success: true, data: [] };
    throw err;
  }
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
  await ensureTables(env);
  const now = new Date().toISOString();
  const res = await env.VIBE_D1.prepare('UPDATE notes SET text = ?, updated_at = ? WHERE id = ?').bind(text, now, id).run();
  if (!res.meta?.changes) return { success: false, error: 'note not found' };
  const row = await env.VIBE_D1.prepare('SELECT * FROM notes WHERE id = ?').bind(id).first();
  return { success: true, data: toNote(row) };
}

/**
 * @mcp-expose
 * @description Delete a note by id. Returns the deleted id.
 * @param {string} id - Note id (required)
 */
async function delete_note(id, env) {
  if (!id || typeof id !== 'string') return { success: false, error: 'id is required' };
  await ensureTables(env);
  const res = await env.VIBE_D1.prepare('DELETE FROM notes WHERE id = ?').bind(id).run();
  if (!res.meta?.changes) return { success: false, error: 'note not found' };
  return { success: true, data: { deleted: id } };
}

// --- Function registry ---

const apiFunctions = {
  add_note: (a, env) => add_note(a.text, a.tag, env),
  list_notes: (a, env) => list_notes(a.tag, a.limit, env),
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
      if (error && error.code === 'ENTITLEMENT_EXCEEDED') throw error;
      return json({ success: false, error: error.message }, 500);
    }
  }
};
