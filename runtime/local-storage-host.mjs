import { withLocalOutbound } from './local-outbound.mjs';
import { VibeStorage, VibeStorageDO, AccountBudgetDO, bookDispatch, getPlan, getPlanLimit,
  planHasFeature, jsonResponse, D1_STORAGE_FULL,
  classifyD1, assertD1SingleStatement, d1DdlNoop, D1_ENTITLEMENT_REQUIRED, WRITE_ACCESS_DENIED,
  sqlErrorMessageForAuthor } from './dev-storage.js';
// The adapter's own error class, so a direct STORAGE call gets the same structured refusal as the facade.
import { D1EntitlementError } from './client-adapter.js';

export { VibeStorageDO, AccountBudgetDO };

const SIGNED_URL_REFUSAL = 'Signed file links are not available in vibe dev; test them on preview.';
const INVALID_STATEMENT = 'Invalid SQL statement: prepare() takes a non-empty SQL string of at most 100,000 characters and at most 100 parameters';
const INVALID_PARAMETER = 'Invalid SQL parameter: use strings, numbers, booleans, null or bytes (at most 100)';
const INVALID_BATCH = 'batch() takes 1 to 100 statements made with prepare()';
let registryReady = false;

// Native statement errors reach author code in the hosted broker's wording.
function authorSqlError(error) {
  if (!(error instanceof Error)) return error;
  const message = sqlErrorMessageForAuthor(error.message);
  if (message === error.message) return error;
  const translated = new Error(message);
  translated.name = error.name;
  return translated;
}

async function initializeRegistry(env, config) {
  if (registryReady) return;
  const db = env.PLATFORM_DB;
  await db.prepare('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, plan TEXT NOT NULL)').run();
  await db.prepare("CREATE TABLE IF NOT EXISTS vibes (id INTEGER PRIMARY KEY, ownerUserId INTEGER NOT NULL, status TEXT NOT NULL, r2BytesUsed INTEGER NOT NULL DEFAULT 0)").run();
  await db.prepare('INSERT OR REPLACE INTO users (id, plan) VALUES (1, ?)').bind(config.plan).run();
  await db.prepare("INSERT OR IGNORE INTO vibes (id, ownerUserId, status) VALUES (?, 1, 'active')").bind(Number(config.vibeId)).run();
  registryReady = true;
}

// Local D1 applies the broker's statement rules to a native binding. There is no
// retained Free database locally, so the broker's kept rules never apply here.
function localD1(env, ctx, props) {
  function requireDatabase() {
    if (!getPlan(props.plan)) throw new Error('SQL is temporarily unavailable; retry shortly.');
    if (!planHasFeature(props.plan, 'd1_storage') || !env.VIBE_D1) throw new D1EntitlementError(D1_ENTITLEMENT_REQUIRED);
    if (!env.BUDGET_DO) throw new Error('SQL is temporarily unavailable; retry shortly.');
    if (Date.now() > props.openedAt + 140_000) throw new Error('Storage usage reporting unavailable; further storage operations are refused');
  }
  function descriptor(value) {
    if (!value || typeof value.sql !== 'string' || !['run', 'all', undefined].includes(value.method)
      || (value.params !== undefined && (!Array.isArray(value.params) || value.params.length > 100))) throw new Error(INVALID_STATEMENT);
    // Refuse tails before classification: native D1 can execute more than one statement.
    assertD1SingleStatement(value.sql);
    const params = value.params === undefined ? [] : Array.from(value.params, (param, index) => {
      if (!Object.hasOwn(value.params, index)) throw new Error(INVALID_PARAMETER);
      if (param === null || typeof param === 'string' || typeof param === 'boolean' || (typeof param === 'number' && Number.isFinite(param))) return param;
      if (param instanceof ArrayBuffer) return param.slice(0);
      if (ArrayBuffer.isView(param)) return param.buffer.slice(param.byteOffset, param.byteOffset + param.byteLength);
      if (Array.isArray(param) && Array.from(param, (byte, i) => Object.hasOwn(param, i) && Number.isInteger(byte) && byte >= 0 && byte <= 255).every(Boolean)) return param.slice();
      throw new Error(INVALID_PARAMETER);
    });
    return { ...value, params };
  }
  async function prepare(target, value) {
    requireDatabase();
    const flags = classifyD1(value.sql);
    if (props.mode !== 'write') {
      if (flags.ddl) return null;
      if (!flags.read) throw new Error(WRITE_ACCESS_DENIED);
    }
    if (flags.growth) {
      const probe = await target.prepare('SELECT 1').all();
      const size = probe?.meta?.size_after;
      if (!Number.isSafeInteger(size) || size < 0) throw new Error(D1_STORAGE_FULL);
      if (size >= getPlanLimit(props.plan, 'maxD1StoragePerVibeMB') * 1024 * 1024) {
        // Idempotent bootstrap remains a no-op at the byte cap.
        if (flags.ddl) return null;
        throw new Error(D1_STORAGE_FULL);
      }
    }
    return target.prepare(value.sql).bind(...value.params);
  }
  function book(result) {
    const rows = result?.meta?.rows_written;
    bookDispatch(env, ctx, { userId: props.ownerUserId, plan: props.plan, nowMs: Date.now(),
      storageMicro: Number.isSafeInteger(rows) && rows >= 0 ? rows : props.plan === 'free' ? 500 : 10_000 });
  }
  function forwarding(target) {
    return {
      async execute(input) {
        const value = descriptor(input);
        const statement = await prepare(target, value);
        if (!statement) return d1DdlNoop();
        let result;
        try { result = await statement[value.method ?? 'all'](); }
        catch (error) { book(); throw authorSqlError(error); }
        book(result);
        return result;
      },
      async batch(inputs) {
        if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 100) throw new Error(INVALID_BATCH);
        const values = Array.from(inputs, (value, index) => {
          if (!Object.hasOwn(inputs, index)) throw new Error(INVALID_BATCH);
          return descriptor(value);
        });
        // Validate the complete batch before native execution, including in sessions.
        const statements = [];
        for (const value of values) statements.push(await prepare(target, value));
        const native = statements.filter(Boolean);
        let results;
        try { results = native.length ? await target.batch(native) : []; }
        catch (error) { for (const _ of native) book(); throw authorSqlError(error); }
        for (let i = 0; i < native.length; i++) book(results[i]);
        let index = 0;
        return statements.map(statement => statement ? results[index++] : d1DdlNoop());
      },
    };
  }
  return {
    ...forwarding(env.VIBE_D1),
    async openSession(options) {
      requireDatabase();
      const session = env.VIBE_D1.withSession(options?.constraint);
      return { ...forwarding(session), getBookmark() { requireDatabase(); return session.getBookmark(); } };
    },
  };
}

class LocalVibeStorage extends VibeStorage {
  d1Execute(value) { return localD1(this.env, this.ctx, this.ctx.props).execute(value); }
  d1Batch(values) { return localD1(this.env, this.ctx, this.ctx.props).batch(values); }
  d1OpenSession(options) { return localD1(this.env, this.ctx, this.ctx.props).openSession(options); }
  async createUploadUrl() { throw new Error(SIGNED_URL_REFUSAL); }
  async createDownloadUrl() { throw new Error(SIGNED_URL_REFUSAL); }
}

export function withLocalStorage(adapter) { return {
  async fetch(request, env, ctx) {
    const config = env.LOCAL_CONFIG;
    if (!getPlan(config.plan)) throw new Error('Local props storage requires a known account plan; sign in and retry vibe dev');
    await initializeRegistry(env, config);
    const props = { invocationId: crypto.randomUUID(), openedAt: Date.now(), ownerUserId: 1,
      vibeId: Number(config.vibeId), env: 'preview', mode: 'write', plan: config.plan,
      generation: 'props', unitCeiling: config.plan === 'free' ? 500 : 10_000,
      kvAlias: `${config.userSlug}--${config.vibeSlug}` };
    const storage = new LocalVibeStorage({ props, waitUntil: task => ctx.waitUntil(task) }, env);
    const headers = new Headers(request.headers);
    for (const name of ['x-vibe-access-mode', 'x-vibe-access-token', 'x-vibe-storage-units', 'x-vibe-subrequests']) headers.delete(name);
    const authorEnv = { ...env.AUTHOR_ENV, VIBE_ID: config.vibeId, VIBE_SLUG: config.vibeSlug,
      USER_SLUG: config.userSlug, VIBE_ENV: 'preview' };
    try {
      return await withLocalOutbound(props, () => adapter.fetch(new Request(request, { headers }), authorEnv, {
        props: { STORAGE: storage, mode: props.mode }, waitUntil: task => ctx.waitUntil(task),
        passThroughOnException: () => ctx.passThroughOnException(),
      }));
    } catch (error) {
      return jsonResponse({ success: false, error: error.message }, 500);
    }
  },
}; }
