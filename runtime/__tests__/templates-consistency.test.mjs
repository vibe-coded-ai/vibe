import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const SKILL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATES = join(SKILL_ROOT, 'templates');

// Models Cloudflare KV: get() sees your own writes immediately, but list()
// only returns keys written before the last "sync" (eventual consistency).
function laggyKv() {
  const data = new Map();
  let listed = new Set();
  return {
    sync() { listed = new Set(data.keys()); },
    async get(k) { return data.has(k) ? data.get(k) : null; },
    async put(k, v) { data.set(k, v); },
    async delete(k) { data.delete(k); },
    async list({ prefix }) {
      return { keys: [...listed].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

async function call(worker, env, fn, args) {
  const res = await worker.fetch(new Request(`https://x.test/api/${fn}`, { method: 'POST', body: JSON.stringify(args) }), env);
  return res.json();
}

for (const [template, write, writeArgs, read, readArgs, pick] of [
  ['tracker', 'add_item', { name: 'Order the range hood', priority: 'high' }, 'list_items', {}, (r) => r.data.map((i) => i.name)],
  ['journal', 'log_entry', { title: 'Sourdough', notes: 'first bake' }, 'list_entries', {}, (r) => r.data.map((e) => e.title)],
  ['log', 'record', { message: 'deploy finished' }, 'tail', {}, (r) => r.data.map((e) => e.message)],
  ['tools', 'add_note', { text: 'Buy more flour' }, 'list_notes', {}, (r) => r.data.map((n) => n.text)],
]) {
  test(`${template}: ${read} includes a record written moments earlier (KV list lag)`, async () => {
    const { default: worker } = await import(join(TEMPLATES, template, 'worker.js'));
    const kv = laggyKv();
    const env = { VIBE_STORAGE: kv };
    const created = await call(worker, env, write, writeArgs);
    assert.equal(created.success, true, JSON.stringify(created));
    const listed = await call(worker, env, read, readArgs);   // no kv.sync(): list() is stale
    assert.equal(listed.success, true, JSON.stringify(listed));
    assert.deepEqual(pick(listed), [Object.values(writeArgs)[0]]);
    kv.sync();                                                   // once list() catches up, no duplicates
    const later = await call(worker, env, read, readArgs);
    assert.deepEqual(pick(later), [Object.values(writeArgs)[0]]);
  });
}

// Only registered tools dispatch: inherited names like constructor are 404, not
// a call into Object.
for (const template of ['tracker', 'journal', 'log', 'tools', 'tools-sql']) {
  test(`${template}: /api/constructor and /api/toString are not tools`, async () => {
    const { default: worker } = await import(join(TEMPLATES, template, 'worker.js'));
    for (const name of ['constructor', 'toString', '__proto__']) {
      const res = await worker.fetch(new Request(`https://x.test/api/${name}`, { method: 'POST', body: '{"echo":1}' }), { VIBE_STORAGE: laggyKv() });
      assert.equal(res.status, 404, `${template} /api/${name} → ${res.status}`);
    }
  });
}

test('tools: list_notes follows every list() page, not just the first', async () => {
  const { default: worker } = await import(join(TEMPLATES, 'tools', 'worker.js'));
  const data = new Map();
  const env = { VIBE_STORAGE: {
    async get(k) { return data.has(k) ? data.get(k) : null; },
    async put(k, v) { data.set(k, v); },
    async list({ prefix, cursor }) {   // pages of 2 keys, like KV's 1000-key pages
      const all = [...data.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const keys = all.slice(start, start + 2).map((name) => ({ name }));
      const done = start + 2 >= all.length;
      return { keys, list_complete: done, cursor: done ? undefined : String(start + 2) };
    },
  } };
  for (let i = 0; i < 5; i++) {
    const id = `id${i}`;
    data.set(`notes:${id}`, JSON.stringify({ id, text: `n${i}`, tag: null, createdAt: `2026-01-0${i + 1}` }));
  }
  const res = await call(worker, env, 'list_notes', {});
  assert.equal(res.data.length, 5);
});

test('tools: delete_note removes the exact verification record', async () => {
  const { default: worker } = await import(join(TEMPLATES, 'tools', 'worker.js'));
  const kv = laggyKv();
  const env = { VIBE_STORAGE: kv };
  const created = await call(worker, env, 'add_note', { text: 'vibe verification test' });
  const deleted = await call(worker, env, 'delete_note', { id: created.data.id });
  assert.deepEqual(deleted, { success: true, data: { deleted: created.data.id } });
  const listed = await call(worker, env, 'list_notes', {});
  assert.deepEqual(listed.data, []);
});

// SKILL.md's verify step deletes the test record by id, so every template with
// a worker needs a delete tool.
for (const [template, write, writeArgs, read, del, prefix] of [
  ['tracker', 'add_item', { name: 'vibe verification test' }, 'list_items', 'delete_item', 'items:'],
  ['journal', 'log_entry', { title: 'vibe verification test', notes: '' }, 'list_entries', 'delete_entry', 'entries:'],
  ['log', 'record', { message: 'vibe verification test' }, 'tail', 'delete_event', 'events:'],
]) {
  test(`${template}: add → list → ${del} → list leaves no record (KV list lag)`, async () => {
    const { default: worker } = await import(join(TEMPLATES, template, 'worker.js'));
    const kv = laggyKv();
    const env = { VIBE_STORAGE: kv };
    const created = await call(worker, env, write, writeArgs);
    assert.equal((await call(worker, env, read, {})).data.length, 1);
    kv.sync();                                   // list() now holds the key; it stays stale after delete
    const deleted = await call(worker, env, del, { id: created.data.id });
    assert.deepEqual(deleted, { success: true, data: { deleted: created.data.id } });
    assert.deepEqual((await call(worker, env, read, {})).data, []);
    assert.deepEqual(JSON.parse(await kv.get(`recent:${prefix}`)), []);
    assert.equal((await call(worker, env, del, { id: created.data.id })).success, false);
  });
}

test('every template with a worker exposes a delete tool', () => {
  for (const template of readdirSync(TEMPLATES)) {
    const file = join(TEMPLATES, template, 'worker.js');
    if (!existsSync(file)) continue;
    // The @mcp-expose must sit in the JSDoc block directly above delete_*:
    // (?:(?!\*\/)[\s\S])* can't cross the end of an earlier block.
    assert.match(readFileSync(file, 'utf8'), /\/\*\*(?:(?!\*\/)[\s\S])*@mcp-expose(?:(?!\*\/)[\s\S])*\*\/\s*async function delete_[a-z_]+\(/, `${template} has no exposed delete_* tool`);
  }
});

test('tools-sql: only the expected not-yet-created table maps to an empty list', async () => {
  const { default: worker } = await import(join(TEMPLATES, 'tools-sql', 'worker.js'));
  const envFor = (message) => ({
    VIBE_D1: {
      prepare() {
        return {
          bind() { return this; },
          async all() { throw new Error(message); },
        };
      },
    },
  });

  const expectedMissing = await call(worker, envFor('D1_ERROR: no such table: notes'), 'list_notes', {});
  assert.deepEqual(expectedMissing, { success: true, data: [] });

  const typo = await worker.fetch(new Request('https://x.test/api/list_notes', {
    method: 'POST',
    body: '{}',
  }), envFor('D1_ERROR: no such table: notse'));
  assert.equal(typo.status, 500);
  assert.match((await typo.json()).error, /no such table: notse/);
});

test('tools-sql: entitlement errors reach the shim from preparation and read execution', async () => {
  const { default: worker } = await import(join(TEMPLATES, 'tools-sql', 'worker.js'));
  const error = Object.assign(new Error('SQL plan required'), { code: 'ENTITLEMENT_EXCEEDED' });
  const request = (fn, args) => new Request(`https://x.test/api/${fn}`, {
    method: 'POST',
    body: JSON.stringify(args),
  });
  const unavailableEnv = { VIBE_D1: { prepare() { throw error; } } };

  for (const [fn, args] of [
    ['list_notes', {}],
    ['add_note', { text: 'test note' }],
    ['update_note', { id: 'test-note', text: 'updated note' }],
    ['delete_note', { id: 'test-note' }],
  ]) {
    await assert.rejects(worker.fetch(request(fn, args), unavailableEnv), (err) => err === error);
  }

  const readEnv = { VIBE_D1: {
    prepare() { return { bind() { return this; }, async all() { throw error; } }; },
  } };
  await assert.rejects(worker.fetch(request('list_notes', {}), readEnv), (err) => err === error);

  const failedEnv = { VIBE_D1: { prepare() { throw new Error('database failure'); } } };
  const res = await worker.fetch(request('list_notes', {}), failedEnv);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { success: false, error: 'database failure' });
});

// A read-only caller's CREATE TABLE is a no-op on the platform. The worker
// must not remember "table created" from that call, or the owner's next write
// in the same isolate skips the CREATE and fails.
test('tools-sql: a read-only caller hitting a write tool does not break the owner\'s first write', async () => {
  const { default: worker } = await import(join(TEMPLATES, 'tools-sql', 'worker.js'));
  const db = { tableExists: false, rows: [], readOnly: true };
  const env = {
    VIBE_D1: {
      prepare(sql) {
        const isDdl = /^\s*CREATE TABLE/i.test(sql);
        const stmt = {
          bind() { return stmt; },
          async run() {
            if (isDdl) { if (!db.readOnly) db.tableExists = true; return {}; }   // no-op for readers
            if (db.readOnly) throw new Error('Write access denied');
            if (!db.tableExists) throw new Error('D1_ERROR: no such table: notes');
            db.rows.push(sql);
            return {};
          },
          async all() { if (!db.tableExists) throw new Error('D1_ERROR: no such table: notes'); return { results: [] }; },
        };
        return stmt;
      },
    },
  };
  const denied = await worker.fetch(new Request('https://x.test/api/add_note', { method: 'POST', body: '{"text":"from a reader"}' }), env);
  assert.equal(denied.status, 500);
  db.readOnly = false;                                    // same module instance, now the owner
  const saved = await call(worker, env, 'add_note', { text: 'from the owner' });
  assert.equal(saved.success, true, JSON.stringify(saved));
  assert.equal(db.tableExists, true);
  assert.equal(db.rows.length, 1);
});

test('tracker: only the page\'s status and priority values are accepted', async () => {
  const { default: worker } = await import(join(TEMPLATES, 'tracker', 'worker.js'));
  const env = { VIBE_STORAGE: laggyKv() };
  assert.match((await call(worker, env, 'add_item', { name: 'x', status: 'closed' })).error, /status must be one of: open, in progress, blocked, done/);
  assert.match((await call(worker, env, 'add_item', { name: 'x', priority: 'medium' })).error, /priority must be one of: low, normal, high, urgent/);
  const item = (await call(worker, env, 'add_item', { name: 'x', status: 'in progress', priority: 'urgent' })).data;
  assert.equal(item.status, 'in progress');
  assert.match((await call(worker, env, 'update_status', { id: item.id, status: 'finished' })).error, /status must be one of/);
});

test('tracker: update_status replaces notes when given, keeps them when omitted, rejects non-text', async () => {
  const { default: worker } = await import(join(TEMPLATES, 'tracker', 'worker.js'));
  const env = { VIBE_STORAGE: laggyKv() };
  const item = (await call(worker, env, 'add_item', { name: 'Ship the draft', notes: 'first' })).data;
  const replaced = await call(worker, env, 'update_status', { id: item.id, status: 'blocked', notes: 'waiting on review' });
  assert.deepEqual([replaced.data.status, replaced.data.notes], ['blocked', 'waiting on review']);
  const kept = await call(worker, env, 'update_status', { id: item.id, status: 'done' });
  assert.deepEqual([kept.data.status, kept.data.notes], ['done', 'waiting on review']);
  const bad = await call(worker, env, 'update_status', { id: item.id, status: 'done', notes: 5 });
  assert.deepEqual(bad, { success: false, error: 'notes must be text' });
});

test('journal: the date must be a real calendar day in YYYY-MM-DD', async () => {
  const { default: worker } = await import(join(TEMPLATES, 'journal', 'worker.js'));
  const env = { VIBE_STORAGE: laggyKv() };
  for (const date of ['2026-02-31', '2025-02-29', '2026-13-01', '2026-09-9', '26-09-09', 'yesterday', 20260909]) {
    const res = await call(worker, env, 'log_entry', { title: 't', notes: 'n', date });
    assert.deepEqual(res, { success: false, error: 'date must be YYYY-MM-DD' }, String(date));
  }
  for (const date of ['2026-02-28', '2028-02-29', '2026-12-31']) {
    const res = await call(worker, env, 'log_entry', { title: 't', notes: 'n', date });
    assert.equal(res.success, true, date);
    assert.equal(res.data.date, date);
  }
});

test('journal: list and search sort by user date, then insertion time', async () => {
  const { default: worker } = await import(join(TEMPLATES, 'journal', 'worker.js'));
  const kv = laggyKv();
  await kv.put('entries:old-backfill', JSON.stringify({
    id: 'old-backfill', title: 'Bake old', notes: 'bread', flour: '',
    date: '2026-09-20', createdAt: '2026-09-28T10:00:00.000Z',
  }));
  await kv.put('entries:newer-date-older-insert', JSON.stringify({
    id: 'newer-date-older-insert', title: 'Bake first', notes: 'bread', flour: '',
    date: '2026-09-27', createdAt: '2026-09-27T10:00:00.000Z',
  }));
  await kv.put('entries:newer-date-newer-insert', JSON.stringify({
    id: 'newer-date-newer-insert', title: 'Bake second', notes: 'bread', flour: '',
    date: '2026-09-27', createdAt: '2026-09-27T11:00:00.000Z',
  }));
  kv.sync();
  const env = { VIBE_STORAGE: kv };
  const listed = await call(worker, env, 'list_entries', {});
  assert.deepEqual(listed.data.map((entry) => entry.id), [
    'newer-date-newer-insert', 'newer-date-older-insert', 'old-backfill',
  ]);
  const searched = await call(worker, env, 'search_entries', { query: 'bread' });
  assert.deepEqual(searched.data.map((entry) => entry.id), [
    'newer-date-newer-insert', 'newer-date-older-insert', 'old-backfill',
  ]);
});

for (const template of ['tools', 'tools-sql']) {
  test(`${template}: API router accepts platform-valid tool names containing digits`, () => {
    const worker = readFileSync(join(TEMPLATES, template, 'worker.js'), 'utf8');
    assert.match(worker, /\[a-z\]\[a-z0-9_\]\*/);
  });

  test(`${template}: form checks HTTP and JSON success before clearing input`, () => {
    const html = readFileSync(join(TEMPLATES, template, 'index.html'), 'utf8');
    assert.match(html, /!response\.ok \|\| result\.success !== true/);
    assert.match(html, /result\.error \|\| `Request failed/);
    assert.ok(html.indexOf("await call('add_note'") < html.indexOf('e.target.reset()'));
    assert.match(html, /role="alert"/);
  });
}

test('Vue reference includes every required file and builds before preview', () => {
  const reference = readFileSync(join(SKILL_ROOT, 'references', 'vue-template.md'), 'utf8');
  for (const section of ['## package.json', '## tsconfig.json', '## vite.config.ts', '## index.html', '## src/main.ts', '## src/App.vue', '## src/vite-env.d.ts']) {
    assert.match(reference, new RegExp(section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.ok(reference.indexOf('npm install') < reference.indexOf('npm run build'));
  assert.ok(reference.indexOf('npm run build') < reference.indexOf('vibe preview'));
});
