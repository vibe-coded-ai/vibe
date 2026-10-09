#!/usr/bin/env node
/**
 * vibe dev — local dev server for fullstack vibes.
 *
 * Runs the user's worker on the REAL Cloudflare runtime (workerd, via Miniflare)
 * with local D1 + KV + R2, composed behind the verbatim platform shim. This is
 * the same module layout the build-runner deploys (main_module = _platform-shim.js
 * importing ./worker.js), so local behaviour matches production by construction —
 * no hand-rolled storage emulation, no "works locally, breaks on deploy" drift.
 *
 * Invoked by `bin/vibe dev`. Not meant to be run directly by users.
 *
 * Parity sources (keep aligned):
 *   - bindings + main_module + compat date: services/build-runner/src/utils/cf-api.ts
 *   - bundle flags:                         services/build-runner/src/steps/bundle-worker.ts
 *   - shim:                                 runtime/platform-shim.js (byte-identical to
 *                                           scripts/build/platform-shim.js — CI-guarded)
 *   - forwarded request headers:            runtime/dispatch-header-policy.mjs (byte-identical
 *                                           to src/services/ — CI-guarded)
 */

import { createServer as createNetServer } from 'node:net';
import { createServer } from 'node:http';
import { readFileSync, existsSync, rmSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { splitSqlStatements } from './sql-statements.mjs';
import { isForwardableHeader } from './dispatch-header-policy.mjs';
import { extractToolsWithWarnings } from './mcp-tools.mjs';

export { extractTools, extractToolsWithWarnings } from './mcp-tools.mjs';

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url))); // skills/vibe-coded-ai
const VENDORED_SHIM = join(SKILL_DIR, 'runtime', 'platform-shim.js');
const MCP_PROTOCOL_VERSION = '2025-06-18';

// ── Lazy deps (resolved from the skill's own node_modules) ────────────────────
async function loadDeps() {
  try {
    const { Miniflare } = await import('miniflare');
    const chokidar = (await import('chokidar')).default;
    return { Miniflare, chokidar };
  } catch (err) {
    console.error(
      'Error: local dev dependencies not installed.\n' +
      `Run:  (cd "${SKILL_DIR}" && npm install)\n` +
      `Cause: ${err && err.message ? err.message : err}`
    );
    process.exit(1);
  }
}

// ── Args / manifest ───────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { port: 8787, reset: false, seed: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') opts.port = parseInt(argv[++i], 10);
    else if (a === '--reset') opts.reset = true;
    else if (a === 'seed') {
      opts.seed = argv[++i];
      if (!opts.seed) {
        console.error('Error: `vibe dev seed` requires a .sql file path.');
        process.exit(1);
      }
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    console.error('Error: --port must be an integer 1-65535');
    process.exit(1);
  }
  return opts;
}

function loadManifest() {
  const p = resolve('.vibe-coded.json');
  if (!existsSync(p)) {
    console.error("Error: No .vibe-coded.json in current directory. Run 'vibe init' first.");
    process.exit(1);
  }
  const m = JSON.parse(readFileSync(p, 'utf8'));
  return {
    vibeSlug: m.vibeSlug,
    userSlug: m.userSlug,
    type: m.type || 'fullstack',
    storage: m.storage || 'kv',
    // VIBE_ID is the R2 isolation boundary; the shim demands a positive integer.
    // Local has no real id, so default to 1 → keys land under vibes/1/.
    vibeId: String(m.vibeId || '1'),
  };
}

export function findWorkerFile() {
  for (const f of ['worker.ts', 'worker.js']) {
    if (existsSync(resolve(f))) return resolve(f);
  }
  return null;
}

function findNestedWorkerFile() {
  for (const f of ['src/worker.ts', 'src/worker.js']) {
    if (existsSync(resolve(f))) return f;
  }
  return null;
}

export function printDroppedTools(warnings) {
  for (const warning of warnings.filter((item) =>
    item.severity === 'error' || item.issue.includes('will not be extracted by the platform'))) {
    console.error(`Warning: MCP tool '${warning.tool}' was dropped: ${warning.issue}`);
  }
}

// ── .dev.vars (local secrets) ─────────────────────────────────────────────────
function loadDevVars() {
  const p = resolve('.dev.vars');
  if (!existsSync(p)) return {};
  const out = {};
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[t.slice(0, eq).trim()] = val;
  }
  return out;
}

// ── Bundling (mirror build-runner: prefer bun, fall back to esbuild) ───────────
function hasBun() {
  try { execFileSync('bun', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

async function bundleWorker(entry, outFile) {
  // Production uses `bun build --target=browser --format=esm --minify`. Locally
  // we drop --minify (identical semantics, readable stack traces) and inline a
  // sourcemap for debugging.
  if (hasBun()) {
    execFileSync('bun', [
      'build', entry, `--outfile=${outFile}`,
      '--target=browser', '--format=esm', '--sourcemap=inline',
    ], { stdio: 'inherit' });
    return;
  }
  let esbuild;
  try { esbuild = await import('esbuild'); }
  catch {
    console.error(`Error: need either 'bun' on PATH or esbuild installed (cd "${SKILL_DIR}" && npm install).`);
    process.exit(1);
  }
  await esbuild.build({
    entryPoints: [entry], outfile: outFile, bundle: true,
    format: 'esm', platform: 'browser', target: 'esnext', sourcemap: 'inline',
  });
}

// ── Miniflare options ─────────────────────────────────────────────────────────
export function buildMfOptions(devDir, manifest, secrets, vibeAccessToken) {
  return {
    // Explicit module graph (shim entry imports ./worker.js) — avoids Miniflare's
    // acorn-based auto-collection, which mis-parses the bundled worker.
    modulesRoot: devDir,
    modules: [
      { type: 'ESModule', path: join(devDir, '_platform-shim.js') },
      { type: 'ESModule', path: join(devDir, 'worker.js') },
    ],
    compatibilityDate: '2024-01-01', // pin to cf-api.ts
    // The shim imports node:async_hooks (AsyncLocalStorage access-mode guard);
    // production deploys with nodejs_compat (cf-api.ts) — without it workerd
    // refuses to boot: 'No such module "node:async_hooks"'.
    compatibilityFlags: ['nodejs_compat'],
    // Dispatch is in-process (mf.dispatchFetch); Miniflare's own server is unused.
    // Bind loopback on a random free port so it never collides with our http port.
    host: '127.0.0.1',
    port: 0,
    kvNamespaces: { VIBE_STORAGE: 'VIBE_STORAGE' },
    d1Databases: { VIBE_D1: 'VIBE_D1' },
    r2Buckets: { VIBE_R2: 'VIBE_R2' },
    kvPersist: join(devDir, 'kv'),
    d1Persist: join(devDir, 'd1'),
    r2Persist: join(devDir, 'r2'),
    bindings: {
      VIBE_ID: manifest.vibeId,
      VIBE_SLUG: manifest.vibeSlug,
      USER_SLUG: manifest.userSlug,
      ...secrets,
      PLATFORM_VIBE_TOKEN: vibeAccessToken,
    },
  };
}

// ── node http <-> workerd bridge ──────────────────────────────────────────────
async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

export function withDispatchHeaders(headers, manifest, vibeAccessToken, internal = {}) {
  // Mirror src/services/dispatch-headers.ts: forward only the client headers
  // production forwards (Cookie, Authorization and unknown headers are
  // dropped), then inject the context headers. `internal` carries headers
  // vibe dev itself adds, as production's MCP proxy adds x-mcp-call.
  const h = new Headers();
  for (const [name, value] of new Headers(headers)) {
    if (isForwardableHeader(name)) h.set(name, value);
  }
  for (const [name, value] of Object.entries(internal)) h.set(name, value);
  h.set('x-vibe-id', manifest.vibeId);
  h.set('x-vibe-slug', manifest.vibeSlug);
  h.set('x-vibe-user-slug', manifest.userSlug);
  h.set('x-vibe-env', 'preview');
  h.set('x-vibe-access-mode', 'write');
  h.set('x-vibe-access-token', vibeAccessToken);
  h.set('x-client-ip', '127.0.0.1');
  if (!h.has('x-request-id')) h.set('x-request-id', `dev-${Date.now()}`);
  return h;
}

// Relay a worker Response to the node http response. Set-Cookie must be emitted
// as separate headers — Object.fromEntries(headers) would comma-join multiple
// Set-Cookie values into one corrupt header.
async function relayWorkerResponse(wr, res) {
  for (const [k, v] of wr.headers) {
    if (k.toLowerCase() === 'set-cookie') continue; // emitted as an array below
    res.setHeader(k, v);
  }
  const cookies = typeof wr.headers.getSetCookie === 'function' ? wr.headers.getSetCookie() : [];
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  res.writeHead(wr.status);
  res.end(Buffer.from(await wr.arrayBuffer()));
}

// ── Local MCP (minimal subset of src/services/mcp-handler.ts) ─────────────────
async function handleMcp(body, tools, callTool) {
  let rpc;
  try { rpc = JSON.parse(body.toString('utf8')); } catch {
    return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
  }
  const { id, method, params } = rpc;
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'vibe-dev', version: '1.0.0' },
    } };
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools } };
  }
  if (method === 'tools/call') {
    const toolName = params && params.name;
    if (!tools.some((t) => t.name === toolName)) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${toolName}` } };
    }
    const result = await callTool(toolName, (params && params.arguments) || {});
    return { jsonrpc: '2.0', id, result: {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    } };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

// ── Static file fallback (serves the user's frontend) ─────────────────────────
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2',
};

function sendFile(target, res) {
  const buf = readFileSync(target);
  res.writeHead(200, { 'Content-Type': MIME[extname(target)] || 'application/octet-stream' });
  res.end(buf);
}

// Serve an exact static file if one exists for this path. Returns true if served.
// `/` resolves to index.html so a static frontend is authoritative for the root,
// matching production (platform serves the frontend; the worker serves /api).
function tryStaticFile(pathname, res) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  if (!extname(rel)) return false;
  const filePath = resolve('.' + rel);
  // Prevent traversal outside the project dir.
  if (!filePath.startsWith(resolve('.') + '/') || !existsSync(filePath)) return false;
  sendFile(filePath, res);
  return true;
}

// SPA fallback to index.html. Returns true if served.
function serveIndexFallback(res) {
  const indexHtml = resolve('index.html');
  if (!existsSync(indexHtml)) return false;
  sendFile(indexHtml, res);
  return true;
}

/** True when another process already listens on `port` over IPv6 (::1). */
export function ipv6PortTaken(port) {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once('error', (err) => resolve(err.code === 'EADDRINUSE'));
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen(port, '::1');
  });
}

/**
 * True when the project's UI needs a Vite build: a vite.config.* file, or an
 * index.html that loads a .ts/.tsx/.vue/.jsx module. vibe dev serves files
 * as-is, so such a UI renders blank here — the banner says so.
 */
export function needsViteBuild(dir) {
  if (['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'].some((ext) => existsSync(join(dir, `vite.config.${ext}`)))) return true;
  const indexPath = join(dir, 'index.html');
  if (!existsSync(indexPath)) return false;
  return /<script[^>]+src=["'][^"']+\.(tsx?|vue|jsx)["']/i.test(readFileSync(indexPath, 'utf8'));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = loadManifest();
  const devDir = resolve('.vibe-coded', 'dev');

  if (opts.reset) {
    rmSync(devDir, { recursive: true, force: true });
    console.log('Local dev state wiped (.vibe-coded/dev).');
  }
  mkdirSync(devDir, { recursive: true });

  const workerFile = findWorkerFile();
  if (!workerFile) {
    const nestedWorker = findNestedWorkerFile();
    if (nestedWorker) {
      console.error(`Error: found ${nestedWorker}; move the worker to the project root as ./worker.ts or ./worker.js. Production only builds a root worker.`);
      process.exit(1);
    }
    console.error('Error: no worker.ts/worker.js found. `vibe dev` needs a fullstack vibe.');
    process.exit(1);
  }

  const { Miniflare, chokidar } = await loadDeps();

  // Compose the deployed module layout: vendored shim + bundled worker, co-located.
  copyFileSync(VENDORED_SHIM, join(devDir, '_platform-shim.js'));
  let extraction = extractToolsWithWarnings(readFileSync(workerFile, 'utf8'));
  let tools = extraction.tools;
  printDroppedTools(extraction.warnings);
  console.log(`Bundling ${workerFile}…`);
  await bundleWorker(workerFile, join(devDir, 'worker.js'));

  const secrets = loadDevVars();
  const vibeAccessToken = randomBytes(32).toString('hex');
  const mf = new Miniflare(buildMfOptions(devDir, manifest, secrets, vibeAccessToken));

  // Forward a request to the worker via Miniflare.
  const dispatch = async (method, url, headers, body, internal) => {
    return mf.dispatchFetch(url, {
      method, headers: withDispatchHeaders(headers, manifest, vibeAccessToken, internal),
      body: body && body.length ? body : undefined,
    });
  };

  if (opts.seed) {
    const sql = readFileSync(resolve(opts.seed), 'utf8');
    const db = await mf.getD1Database('VIBE_D1');
    const statements = splitSqlStatements(sql);
    for (const stmt of statements) await db.prepare(stmt).run();
    console.log(`Seeded local D1 from ${opts.seed} (${statements.length} statement${statements.length === 1 ? '' : 's'}).`);
    await mf.dispose();
    return;
  }

  // Single local origin: /api + /mcp → worker, everything else → static frontend.
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${opts.port}`);
      const path = url.pathname;
      if (path === '/mcp' || path === '/mcp/' || path.startsWith('/mcp/messages')) {
        const body = (await readBody(req)) || Buffer.from('');
        const rpc = await handleMcp(body, tools, async (name, args) => {
          const r = await dispatch('POST', `http://localhost/api/${name}`,
            { 'content-type': 'application/json' }, Buffer.from(JSON.stringify(args)), { 'x-mcp-call': 'true' });
          return r.json();
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rpc));
        return;
      }
      if (path.startsWith('/api/')) {
        const body = await readBody(req);
        const wr = await dispatch(req.method, `http://localhost${req.url}`, req.headers, body);
        await relayWorkerResponse(wr, res);
        return;
      }
      // Non-API: exact static file → worker (vibes that render routes) → SPA fallback.
      if (tryStaticFile(path, res)) return;
      const body = await readBody(req);
      const wr = await dispatch(req.method, `http://localhost${req.url}`, req.headers, body);
      if (wr.status !== 404) {
        await relayWorkerResponse(wr, res);
        return;
      }
      if (serveIndexFallback(res)) return;
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: String(err && err.message || err) }));
    }
  });

  const nextPort = opts.port < 65535 ? opts.port + 1 : opts.port - 1;
  const portInUseMessage = `Port ${opts.port} is in use — run: vibe dev --port ${nextPort} (or stop the other process).`;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts.port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
    console.error(portInUseMessage);
    await mf.dispose();
    process.exit(1);
  }
  // We listen on IPv4 only, but "localhost" often resolves to ::1 first. If some
  // other program already owns this port on IPv6, requests to localhost would
  // reach it instead of this vibe — refuse rather than start half-reachable.
  if (await ipv6PortTaken(opts.port)) {
    console.error(portInUseMessage);
    await mf.dispose();
    server.close();
    process.exit(1);
  }
  printBanner(manifest, opts.port, tools);

  // Hot-reload: rebundle worker + reload Miniflare on change. Persisted D1/KV/R2
  // survive because they live on disk under .vibe-coded/dev/. Watch only the
  // worker source — not the whole project — to avoid rebundling on frontend edits.
  const workerDir = dirname(workerFile);
  const watchPaths = workerDir === resolve('.') ? [workerFile] : [workerFile, workerDir];
  const watcher = chokidar.watch(watchPaths, {
    ignoreInitial: true, ignored: /node_modules|\.vibe-coded/,
  });
  let reloading = false, pending = false;
  const reload = async () => {
    if (reloading) { pending = true; return; } // coalesce edits during a rebuild
    reloading = true;
    try {
      await bundleWorker(workerFile, join(devDir, 'worker.js'));
      extraction = extractToolsWithWarnings(readFileSync(workerFile, 'utf8'));
      tools = extraction.tools;
      printDroppedTools(extraction.warnings);
      await mf.setOptions(buildMfOptions(devDir, manifest, loadDevVars(), vibeAccessToken));
      console.log(`↻ reloaded (${new Date().toLocaleTimeString()})`);
    } catch (err) {
      console.error(`✗ reload failed: ${err && err.message || err}`);
    } finally {
      reloading = false;
      if (pending) { pending = false; reload(); } // pick up edits made mid-rebuild
    }
  };
  watcher.on('change', reload);
  watcher.on('add', reload);

  const shutdown = async () => {
    console.log('\nShutting down…');
    await watcher.close();
    await mf.dispose();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function printBanner(manifest, port, tools) {
  console.log('');
  console.log(`  vibe dev — ${manifest.userSlug}/${manifest.vibeSlug} (${manifest.storage})`);
  console.log(`  Local:   http://127.0.0.1:${port}`);
  console.log(`  API:     http://127.0.0.1:${port}/api/<function>`);
  console.log(`  MCP:     http://127.0.0.1:${port}/mcp  (${tools.length} tool${tools.length === 1 ? '' : 's'})`);
  console.log(`  State:   .vibe-coded/dev/  (D1 + KV + R2, persisted)`);
  console.log('  Watching worker for changes — Ctrl-C to stop.');
  if (needsViteBuild(process.cwd())) {
    console.log('');
    console.log('  UI:      NOT served here — this is a Vite app and vibe dev does not build it,');
    console.log('           so the page at Local is blank. Test the UI with `npx vite`');
    console.log('           (proxy /api and /mcp to this port) or on `vibe preview`.');
  }
  console.log('');
}

// Run only when invoked directly (not when imported by tests).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
