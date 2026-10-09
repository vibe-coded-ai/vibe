// Unit tests for the pure helpers in dev-server.mjs.
// Run: node --test   (from skills/vibe-coded-ai/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMfOptions, extractTools, extractToolsWithWarnings, printDroppedTools, withDispatchHeaders, ipv6PortTaken, needsViteBuild } from '../dev-server.mjs';
import { splitSqlStatements } from '../sql-statements.mjs';

const VIBE_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../../bin/vibe');
const RUNTIME_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function runCli(command, args = [], scenario = 'normal', detailResponse = {
  success: true,
  visibility: 'public',
  previewMcpToolCount: 17,
  productionMcpToolCount: 14,
  mcpToolCount: 14,
  previewBuildId: 42,
  productionBuildId: 40,
}) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-cli-test-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  const stubBin = join(root, 'bin');
  const log = join(root, 'curl.log');
  mkdirSync(join(home, '.vibe-coded'), { recursive: true });
  mkdirSync(join(project, '.vibe-coded', 'dev'), { recursive: true });
  mkdirSync(stubBin);

  writeFileSync(join(home, '.vibe-coded', 'credentials.json'), JSON.stringify({
    token: 'synthetic-test-token',
    userSlug: 'tester',
    apiUrl: 'https://stub.invalid',
    expiresAt: '2999-01-01T00:00:00Z',
  }));
  if (scenario !== 'nomanifest') {
    writeFileSync(join(project, '.vibe-coded.json'), JSON.stringify({ vibeSlug: 'demo' }));
  }
  if (command !== 'init' || !args.includes('--template')) {
    writeFileSync(join(project, 'index.html'), '<h1>demo</h1>');
  }
  writeFileSync(join(project, '.vibe-coded', 'dev', 'state.json'), '{}');
  const extraLocalPaths = ['over20', 'upload20', 'upload21'].includes(scenario)
    ? Array.from({ length: scenario === 'over20' ? 25 : scenario === 'upload20' ? 19 : 20 }, (_, i) => `local-${i}.html`)
    : [];
  for (const path of extraLocalPaths) writeFileSync(join(project, path), path);
  if (scenario === 'withworker') writeFileSync(join(project, 'worker.js'), 'export default {};');
  if (scenario === 'uploadnames') {
    mkdirSync(join(project, 'assets'));
    writeFileSync(join(project, 'assets', 'style.css'), 'body {}');
    writeFileSync(join(project, 'file with spaces.txt'), 'hello');
    writeFileSync(join(project, '.gitignore'), '.vibe-coded/');
    writeFileSync(join(project, 'assets', '.gitignore'), '*.map');
  }
  // In a git worktree or submodule, .git is a file holding the local gitdir path.
  if (scenario === 'gitfile') writeFileSync(join(project, '.git'), 'gitdir: /Users/someone/private/repo/.git/worktrees/demo');
  if (scenario === 'dotdirs') {
    for (const dir of ['.claude', '.cursor', '.codex', '.vscode']) mkdirSync(join(project, dir), { recursive: true });
    writeFileSync(join(project, '.claude', 'settings.local.json'), '{"env":{"SECRET":"x"}}');
    writeFileSync(join(project, '.cursor', 'rules.md'), 'x');
    writeFileSync(join(project, '.codex', 'config.toml'), 'x');
    writeFileSync(join(project, '.vscode', 'settings.json'), '{}');
    mkdirSync(join(project, '.well-known'), { recursive: true });
    writeFileSync(join(project, '.well-known', 'security.txt'), 'Contact: x');
    mkdirSync(join(project, 'public', '.well-known'), { recursive: true });
    writeFileSync(join(project, 'public', '.well-known', 'assetlinks.json'), '[]');
    writeFileSync(join(project, '.npmrc'), 'legacy-peer-deps=true');
  }
  if (scenario === 'localfiles') {
    writeFileSync(join(project, '.dev.vars'), 'LOCAL_SECRET=do-not-upload');
    writeFileSync(join(project, 'schema.sql'), 'CREATE TABLE private_data (id INTEGER);');
  }
  if (scenario === 'neverserved') {
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'x', dependencies: {} }));
    writeFileSync(join(project, 'bun.lock'), '{}');
    writeFileSync(join(project, 'wrangler.toml'), 'name = "x"');
    writeFileSync(join(project, 'tsconfig.json'), '{}');
    mkdirSync(join(project, 'data'));
    writeFileSync(join(project, 'data', 'plants.json'), '[]');
    mkdirSync(join(project, 'sub'));
    writeFileSync(join(project, 'sub', 'yarn.lock'), '');
    writeFileSync(join(project, 'sub', 'package.json'), '{}');
  }
  if (scenario === 'agentnotes') {
    for (const file of ['AGENTS.md', 'claude.MD', 'GEMINI.md', 'MODEL.md', 'review-MODEL.md', 'OBSERVATIONS.md', 'SPEC.md', 'TODO.md', 'NOTES.md', 'README.md']) {
      writeFileSync(join(project, file), file);
    }
    writeFileSync(join(project, 'worker.ts'), 'export default {}');
    writeFileSync(join(project, 'package.json'), '{}');
    writeFileSync(join(project, 'tsconfig.json'), '{}');
    mkdirSync(join(project, 'content', 'posts'), { recursive: true });
    writeFileSync(join(project, 'content', 'posts', 'MODEL.md'), 'published content');
    writeFileSync(join(project, 'guide.md'), 'public site guide');
  }
  if (scenario === 'dualworker') {
    writeFileSync(join(project, 'worker.ts'), 'export default {};');
    writeFileSync(join(project, 'worker.js'), 'export default {};');
  }
  if (scenario === 'withdist' || scenario === 'staledist') {
    mkdirSync(join(project, 'dist'));
    writeFileSync(join(project, 'dist', 'index.html'), '<h1>built</h1>');
  }
  if (scenario === 'withdist') {
    writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' } }));
  }
  const remotePaths = scenario === 'guard'
    ? ['index.html', 'old-a.html', 'old-b.html']
    : scenario === 'over20'
      ? ['index.html', ...extraLocalPaths, ...Array.from({ length: 21 }, (_, i) => `stale-${i}.html`)]
      : ['index.html', 'stale.html'];
  const listResponse = JSON.stringify({
    success: true,
    files: remotePaths.map(path => ({ path })),
    truncated: false,
  });

  const curlStub = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'method=GET',
    'url=""',
    'data=""',
    'writeout=""',
    'outfile=""',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    -X) method="$2"; shift 2 ;;',
    '    --data|--data-binary|-d) data="$2"; shift 2 ;;',
    '    -w) writeout="$2"; shift 2 ;;',
    '    -o) outfile="$2"; shift 2 ;;',
    '    -H|-K) shift 2 ;;',
    '    -s|-f) shift ;;',
    '    http*) url="$1"; shift ;;',
    '    *) shift ;;',
    '  esac',
    'done',
    'payload="$data"',
    'if [ "$data" = @- ]; then payload=$(cat); elif [[ "$data" == @* ]]; then payload=$(<"${data#@}"); fi',
    'printf "%s\\t%s\\t%s\\n" "$method" "$url" "$payload" >> "$VIBE_TEST_LOG"',
    'emit() { printf "%s" "$1"; if [ -n "$writeout" ]; then printf "\\n%s" "$2"; else printf "\\n"; fi; }',
    'if [ "$VIBE_TEST_SCENARIO" = netdown ]; then exit 7; fi',
    'if [ "$VIBE_TEST_SCENARIO" = auth401 ]; then',
    '  emit \'{"success":false,"error":"Authentication required"}\' 401',
    'elif [[ "$method" = POST && "$url" == */auth/cli/start ]]; then',
    '  emit \'{"success":true,"deviceCode":"synthetic-device-code","verificationUriComplete":"https://stub.invalid/approve","userCode":"TEST","interval":1,"expiresIn":600}\' 200',
    'elif [[ "$method" = POST && "$url" == */auth/cli/poll ]]; then',
    '  if [ "$VIBE_TEST_SCENARIO" = logindenied ]; then',
    '    emit \'{"status":"denied"}\' 200',
    '  else',
    '    emit "$(jq -cn --arg token "$VIBE_TEST_LOGIN_TOKEN" \'{status:"approved",token:$token,userSlug:"tester"}\')" 200',
    '  fi',
    'elif [[ "$method" = GET && "$url" == */api/v1/vibes ]]; then',
    '  emit \'{"success":true,"plan":"pro","vibes":[]}\' 200',
    'elif [[ "$method" = GET && "$url" == *"/tester/demo" && "$VIBE_TEST_SCENARIO" = status401 ]]; then',
    '  emit \'{"success":false,"error":"token revoked"}\' 401',
    'elif [[ "$method" = GET && "$url" == *"/tester/demo" && "$VIBE_TEST_SCENARIO" = status403 ]]; then',
    '  emit \'{"success":false,"error":"access denied"}\' 403',
    'elif [[ "$method" = GET && "$url" == *"/tester/demo" && "$VIBE_TEST_SCENARIO" = status500 ]]; then',
    '  emit \'{"success":false,"error":"service unavailable"}\' 500',
    'elif [[ "$method" = GET && "$url" == *"/builds?limit="* ]]; then',
    '  if [ "$VIBE_TEST_SCENARIO" = pendingpreflight ]; then',
    '    emit \'{"success":true,"builds":[{"id":43,"status":"building","environment":"preview","createdAt":"2026-09-29T12:00:00Z"}]}\' 200',
    '  elif [ "$VIBE_TEST_SCENARIO" = publishfailed ] || [ "$VIBE_TEST_SCENARIO" = publishrestored ]; then',
    '    emit \'{"success":true,"builds":[{"id":43,"status":"failed","environment":"preview","createdAt":"2026-09-29T12:00:00Z"}]}\' 200',
    '  elif [ "$VIBE_TEST_SCENARIO" = withworker ]; then',
    '    emit \'{"success":true,"builds":[{"id":42,"status":"succeeded","environment":"preview","createdAt":"2026-09-29T12:00:00Z"}]}\' 200',
    '  else',
    '    emit \'{"success":true,"builds":[]}\' 200',
    '  fi',
    'elif [[ "$method" = POST && "$url" == */api/v1/vibes ]]; then',
    '  if [ "$VIBE_TEST_SCENARIO" = vibecappro ]; then',
    '    emit \'{"success":false,"error":"Vibe limit reached (25/25). Delete a vibe you no longer need: https://vibe-coded.ai/account.","code":"ENTITLEMENT_EXCEEDED","limitType":"maxVibes","limit":25,"used":25,"plan":"pro","upgradeUrl":"/billing"}\' 403',
    '  elif [ "$VIBE_TEST_SCENARIO" = vibecapbyov ]; then',
    '    emit \'{"success":false,"error":"Vibe limit reached (10/10).","code":"ENTITLEMENT_EXCEEDED","limitType":"maxVibes","limit":10,"used":10,"plan":"byov","upgradeUrl":"/billing"}\' 403',
    '  elif [ "$VIBE_TEST_SCENARIO" = vibecap ]; then',
    '    emit \'{"success":false,"error":"Vibe limit reached (5/5). Pro ($9/mo) supports up to 10 vibes; Pro+ ($20/mo) supports up to 25 vibes. Or delete a vibe you no longer need: https://vibe-coded.ai/account. Tell your agent: \\"upgrade my vibe-coded.ai plan or delete an unused vibe, then retry.\\"","code":"ENTITLEMENT_EXCEEDED","limitType":"maxVibes","limit":5,"used":5,"plan":"free","upgradeUrl":"/billing"}\' 403',
    '  else',
    '    printf \'%s\\n\' \'{"success":true,"vibe":{"id":1}}\'',
    '  fi',
    'elif [[ "$method" = POST && "$url" == *"/source" ]]; then',
    '  if [ "$VIBE_TEST_SCENARIO" = upload401 ]; then',
    '    emit \'{"success":false,"error":"Authentication required"}\' 401',
    '  elif [ "$VIBE_TEST_SCENARIO" = buildlimit ]; then',
    '    emit \'{"success":false,"error":"Free allows 10 builds an hour. Your next build is available in 14 minutes (at 14:32 UTC). Keep iterating with `vibe dev`, which has no build limit. Or upgrade to Pro ($9/mo, 30 an hour): https://vibe-coded.ai/pricing","reason":"hourly_limit","retryAt":"2026-09-29T14:32:00.000Z","retryAfterSeconds":810}\' 429',
    '  elif [ "$VIBE_TEST_SCENARIO" = rejected ]; then',
    '    printf \'%s\\n\' \'{"success":false,"uploaded":["index.html"],"errors":[{"path":"init.log","error":"File type .log not allowed"}]}\'',
    '  else',
    '    printf \'%s\\n\' \'{"success":true,"buildSkipped":true}\'',
    '  fi',
    'elif [[ "$method" = GET && "$url" == *"/source?limit=1000"* ]]; then',
    '  if [ "$VIBE_TEST_SCENARIO" = invalid ]; then',
    '    printf \'not-json\\n\'',
    '  else',
    '    printf \'%s\\n\' "$VIBE_TEST_LIST_RESPONSE"',
    '  fi',
    'elif [[ "$method" = DELETE && "$url" == *"/source" ]]; then',
    '  printf \'%s\\n\' \'{"success":true,"buildSkipped":true}\'',
    'elif [[ "$method" = POST && "$url" == *"/publish" && "$VIBE_TEST_SCENARIO" = publishfailed ]]; then',
    '  emit \'{"success":false,"error":"Preview build 43 failed: worker.js:2:24 Expected identifier. Run vibe logs 43 for details, then preview again before publishing."}\' 409',
    'elif [[ "$method" = POST && "$url" == *"/publish" ]]; then',
    '  printf \'%s\\n\' \'{"success":true,"published":true,"buildId":42}\'',
    'elif [[ "$method" = POST && "$url" == *"/mcp" ]]; then',
    '  if [[ "$payload" == *unbuilt_rpc* ]]; then',
    '    emit \'{"jsonrpc":"2.0","error":{"code":-32000,"message":"Vibe not found"},"id":null}\' 404',
    '  elif [[ "$payload" == *unbuilt_tool* ]]; then',
    '    emit \'{"success":false,"error":"Vibe not found"}\' 404',
    '  elif [[ "$payload" == *no_such_tool* ]]; then',
    '    emit \'{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Tool not found"}}\' 404',
    '  elif [[ "$payload" == *failing_tool* ]]; then',
    '    emit "$(printf \'event: message\\ndata: %s\' \'{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"bad input"}],"isError":true}}\')" 200',
    '  else',
    '    emit "$(printf \'event: message\\ndata: %s\' \'{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"success\\":true}"}]}}\')" 200',
    '  fi',
    'elif [[ "$method" = POST && "$url" == *"/mcp-tokens" ]]; then',
    '  if [ "$VIBE_TEST_SCENARIO" = mintfail ]; then',
    '    printf \'%s\\n\' \'{"success":false,"error":"Only the owner can connect this vibe"}\'',
    '  else',
    '    printf \'%s\\n\' \'{"success":true,"token":"conn-tok","jti":"new-jti","expiresAt":"2026-12-26T00:00:00.000Z","url":"https://tester--demo.vibe-coded.ai/mcp"}\'',
    '  fi',
    'elif [[ "$method" = DELETE && "$url" == *"/mcp-tokens/"* ]]; then',
    '  printf \'%s\\n\' \'{"success":true,"revoked":true}\'',
    'elif [[ "$method" = POST && "$url" == *"/r2/download-url" ]]; then',
    '  printf \'%s\\n\' \'{"success":true,"url":"https://signed.invalid/object","expiresAt":1770000120}\'',
    'elif [[ "$method" = GET && "$url" == https://*"tester--demo.vibe-coded.ai"* ]]; then',
    '  code=200; body="<h1>private owner view</h1>"',
    '  [ "$VIBE_TEST_SCENARIO" = fetch401 ] && { code=401; body="{\\"error\\":\\"Authentication required\\"}"; }',
    '  [ "$VIBE_TEST_SCENARIO" = fetch404 ] && { code=404; body="Not found"; }',
    '  if [ -n "$outfile" ]; then printf "%s\\n" "$body" > "$outfile"; else printf "%s\\n" "$body"; fi',
    '  if [ -n "$writeout" ]; then printf "%s" "$code"; fi',
    'elif [[ "$method" = GET && "$url" == *"/tester/demo" ]]; then',
    '  emit "$VIBE_TEST_DETAIL_RESPONSE" 200',
    'else',
    '  printf \'%s\\n\' \'{"success":false,"error":"unexpected stub request"}\'',
    'fi',
  ].join('\n');
  const curlPath = join(stubBin, 'curl');
  writeFileSync(curlPath, curlStub, { mode: 0o755 });
  // Never let a test reach the real Claude Code config: a stub `claude` is
  // first on PATH, and the noclaude scenario drops every dir but the basics.
  let path = `${stubBin}:${process.env.PATH}`;
  if (scenario === 'noclaude') {
    symlinkSync(execFileSync('which', ['jq'], { encoding: 'utf8' }).trim(), join(stubBin, 'jq'));
    path = `${stubBin}:/usr/bin:/bin`;
  } else {
    writeFileSync(join(stubBin, 'claude'), [
      '#!/usr/bin/env bash',
      'printf "claude\\t%s\\n" "$*" >> "$VIBE_TEST_LOG"',
      'if [ "$VIBE_TEST_SCENARIO" = claudefail ] && [ "$2" = add ]; then exit 1; fi',
      'if [ "$2" = get ]; then',
      '  if [ "$VIBE_TEST_SCENARIO" = unreachable ]; then',
      '    printf "%s:\\n  Status: ✘ Failed to connect\\n  Issue: HTTP 404\\n" "$3"; exit 1',
      '  else',
      '    printf "%s:\\n  Scope: User config\\n  Status: ✔ Connected\\n" "$3"',
      '  fi',
      'fi',
    ].join('\n'), { mode: 0o755 });
  }
  const connectionsPath = join(home, '.vibe-coded', 'connections.json');
  if (command === 'login') {
    writeFileSync(join(home, '.vibe-coded', 'pending-login.json'), JSON.stringify({
      deviceCode: 'synthetic-device-code', interval: 1, expiresAt: 4070908800,
    }));
    if (['loginconnected', 'logindenied', 'loginstart'].includes(scenario)) {
      writeFileSync(connectionsPath, JSON.stringify({
        'tester--demo': { jti: 'synthetic-old-demo', name: 'demo' },
        'alice--notes': { jti: 'synthetic-old-notes', name: 'notes' },
      }));
    } else if (scenario === 'loginempty') {
      writeFileSync(connectionsPath, '{}');
    }
  }
  if (scenario === 'nameclash' || scenario === 'samevibe') {
    const url = scenario === 'nameclash' ? 'https://mcp.example.com/mcp' : 'https://tester--demo.vibe-coded.ai/mcp';
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { demo: { type: 'http', url } } }));
  }
  if (scenario === 'connected' || scenario === 'multiconnected') {
    writeFileSync(connectionsPath, JSON.stringify({
      'tester--demo': {
        jti: 'old-jti', expiresAt: '2026-10-01T00:00:00.000Z', name: 'demo',
        ...(scenario === 'multiconnected' ? { additionalJtis: ['printed-jti', 'another-jti'] } : {}),
      },
    }));
  }

  const result = spawnSync('bash', [VIBE_BIN, command, ...args], {
    cwd: project,
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      HOME: home,
      PATH: path,
      VIBE_NO_UPDATE_CHECK: '1',
      VIBE_TEST_LOG: log,
      VIBE_TEST_SCENARIO: scenario,
      VIBE_TEST_LIST_RESPONSE: listResponse,
      VIBE_TEST_DETAIL_RESPONSE: JSON.stringify(detailResponse),
      VIBE_TEST_LOGIN_TOKEN: `synthetic.${Buffer.from(JSON.stringify({ slug: 'tester', exp: 4070908800 })).toString('base64url')}.synthetic`,
    },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
  const connections = existsSync(connectionsPath) ? JSON.parse(readFileSync(connectionsPath, 'utf8')) : null;
  const gitignore = existsSync(join(project, '.gitignore')) ? readFileSync(join(project, '.gitignore'), 'utf8') : '';
  rmSync(root, { recursive: true, force: true });
  return { ...result, calls, connections, gitignore };
}

function runPreview(args = [], scenario = 'normal', detailResponse) {
  return runCli('preview', args, scenario, detailResponse);
}

function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

function setupDevRuntime() {
  const root = mkdtempSync(join(tmpdir(), 'vibe-dev-reset-test-'));
  const skillDir = join(root, 'skill');
  const runtimeDir = join(skillDir, 'runtime');
  const project = join(root, 'project');
  const devDir = join(project, '.vibe-coded', 'dev');
  const staleFile = join(devDir, 'stale-state');
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(devDir, { recursive: true });
  writeFileSync(staleFile, 'stale');
  writeFileSync(join(project, '.vibe-coded.json'), JSON.stringify({
    vibeSlug: 'demo', userSlug: 'tester', type: 'fullstack', storage: 'kv',
  }));
  writeFileSync(join(project, 'worker.js'), 'export default { fetch() { return new Response("ok"); } };');

  for (const file of ['dev-server.mjs', 'mcp-tools.mjs', 'sql-statements.mjs', 'platform-shim.js', 'dispatch-header-policy.mjs']) {
    copyFileSync(join(RUNTIME_DIR, file), join(runtimeDir, file));
  }
  // esbuild stub: without bun on PATH the dev server bundles via esbuild; the stub
  // copies the entry so this test doesn't depend on either being installed.
  for (const packageName of ['miniflare', 'chokidar', 'esbuild']) {
    const packageDir = join(skillDir, 'node_modules', packageName);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }));
  }
  writeFileSync(join(skillDir, 'node_modules', 'miniflare', 'index.js'), `
    export class Miniflare {
      async dispatchFetch() { return new Response('not found', { status: 404 }); }
      async dispose() {}
      async setOptions() {}
    }
  `);
  writeFileSync(join(skillDir, 'node_modules', 'esbuild', 'index.js'), `
    import { copyFileSync } from 'node:fs';
    export async function build({ entryPoints, outfile }) { copyFileSync(entryPoints[0], outfile); }
  `);
  writeFileSync(join(skillDir, 'node_modules', 'chokidar', 'index.js'), `
    export default { watch() { return { on() { return this; }, async close() {} }; } };
  `);
  return { root, runtimeDir, project, devDir, staleFile };
}

test('vibe dev --reset wipes local state and continues to start the server', async (t) => {
  const { root, runtimeDir, project, devDir, staleFile } = setupDevRuntime();
  let port;
  try {
    port = await getFreePort();
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    if (error?.code === 'EPERM') {
      t.skip('loopback binding is not permitted in this environment');
      return;
    }
    throw error;
  }
  const child = spawn(process.execPath, [realpathSync(join(runtimeDir, 'dev-server.mjs')), '--reset', '--port', String(port)], {
    cwd: project,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  });

  await new Promise((resolveStarted, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start\nstdout:\n${stdout}\nstderr:\n${stderr}`)), 10000);
    child.stdout.on('data', () => {
      if (stdout.includes('Watching worker for changes')) {
        clearTimeout(timer);
        resolveStarted();
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`server exited before startup (${code ?? signal})\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });

  assert.equal(existsSync(staleFile), false);
  assert.equal(existsSync(join(devDir, 'worker.js')), true);
  child.kill('SIGTERM');
  await new Promise(resolveExit => child.once('exit', resolveExit));
});

test('vibe dev reports a busy IPv4 or IPv6 port in one actionable line and exits 1', () => {
  const { root, runtimeDir, project } = setupDevRuntime();
  try {
    // Emit Node server events without opening sockets or starting workerd.
    const preload = join(root, 'busy-port.cjs');
    writeFileSync(preload, `
      const { EventEmitter } = require('node:events');
      const http = require('node:http');
      const net = require('node:net');
      const { syncBuiltinESMExports } = require('node:module');
      http.createServer = () => {
        const server = new EventEmitter();
        server.listen = (_port, _host, ready) => {
          queueMicrotask(() => {
            if (process.env.VIBE_TEST_PORT_FAMILY === 'ipv4') {
              server.emit('error', Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }));
            } else ready();
          });
          return server;
        };
        server.close = () => {};
        return server;
      };
      net.createServer = () => {
        const server = new EventEmitter();
        server.listen = () => {
          queueMicrotask(() => server.emit('error', Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })));
          return server;
        };
        return server;
      };
      syncBuiltinESMExports();
    `);
    for (const family of ['ipv4', 'ipv6']) {
      const result = spawnSync(process.execPath, ['--require', preload, realpathSync(join(runtimeDir, 'dev-server.mjs')), '--port', '8787'], {
        cwd: project, encoding: 'utf8', timeout: 10000,
        env: { ...process.env, VIBE_TEST_PORT_FAMILY: family },
      });
      assert.equal(result.status, 1, `${family}: ${result.stderr}`);
      assert.equal(result.stderr, 'Port 8787 is in use — run: vibe dev --port 8788 (or stop the other process).\n');
      assert.doesNotMatch(result.stdout, /Watching worker/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('splitSqlStatements: splits on semicolons, trims', () => {
  const out = splitSqlStatements('CREATE TABLE t (id INT);\nINSERT INTO t VALUES (1);');
  assert.deepEqual(out, ['CREATE TABLE t (id INT)', 'INSERT INTO t VALUES (1)']);
});

test('splitSqlStatements: a -- line comment does NOT swallow the next statement (regression: finding #1)', () => {
  const sql = `INSERT INTO t VALUES (1); -- first row\nINSERT INTO t VALUES (2);`;
  const out = splitSqlStatements(sql);
  assert.deepEqual(out, ['INSERT INTO t VALUES (1)', 'INSERT INTO t VALUES (2)']);
});

test('splitSqlStatements: leading header comment yields the real statements, not zero', () => {
  const sql = `-- seed users\nINSERT INTO users (name) VALUES ('a');`;
  const out = splitSqlStatements(sql);
  assert.deepEqual(out, ["INSERT INTO users (name) VALUES ('a')"]);
});

test('splitSqlStatements: block comments stripped', () => {
  const out = splitSqlStatements('/* header */ SELECT 1; /* mid */ SELECT 2;');
  assert.deepEqual(out, ['SELECT 1', 'SELECT 2']);
});

test('splitSqlStatements: semicolons inside string literals are not split points', () => {
  const out = splitSqlStatements("INSERT INTO t (s) VALUES ('a;b'); SELECT 1;");
  assert.deepEqual(out, ["INSERT INTO t (s) VALUES ('a;b')", 'SELECT 1']);
});

test("splitSqlStatements: escaped '' inside a literal handled", () => {
  const out = splitSqlStatements("INSERT INTO t (s) VALUES ('o''brien');");
  assert.deepEqual(out, ["INSERT INTO t (s) VALUES ('o''brien')"]);
});

test('extractTools: parses @mcp-expose function with params', () => {
  const src = `
    /**
     * @mcp-expose
     * @mcp-scope write
     * @description Create a thing
     * @param {string} name - the name
     * @param {number} [count] - optional count
     */
    async function create_thing(name, count, env) {}
  `;
  const tools = extractTools(src);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'create_thing');
  assert.equal(tools[0].description, 'Create a thing');
  assert.equal(tools[0].inputSchema.properties.name.type, 'string');
  assert.equal(tools[0].inputSchema.properties.count.type, 'number');
  assert.deepEqual(tools[0].inputSchema.required, ['name']); // count is optional
});

test('extractTools: warns when annotated function forms are dropped like the platform extractor', () => {
  const src = `
/** @mcp-expose */
const arrow_tool = async (env) => {};
class Tools {
  /** @mcp-expose */
  async method_tool(env) {}
}
/** @mcp-expose */
function sync_tool(env) {}
`;
  const result = extractToolsWithWarnings(src);
  assert.equal(result.tools.length, 0);
  assert.deepEqual(result.warnings.map(({ tool, severity }) => ({ tool, severity })), [
    { tool: 'arrow_tool', severity: 'warning' },
    { tool: 'method_tool', severity: 'warning' },
    { tool: 'sync_tool', severity: 'warning' },
  ]);
  assert.match(result.warnings[0].issue, /arrow\/variable assignment/);
  assert.match(result.warnings[1].issue, /class or object method/);
  assert.match(result.warnings[2].issue, /non-async function/);

  const messages = [];
  const original = console.error;
  console.error = (message) => messages.push(message);
  try {
    printDroppedTools(result.warnings);
  } finally {
    console.error = original;
  }
  assert.equal(messages.length, 3);
  assert.match(messages[0], /MCP tool 'arrow_tool' was dropped/);
  assert.match(messages[1], /MCP tool 'method_tool' was dropped/);
  assert.match(messages[2], /MCP tool 'sync_tool' was dropped/);
});

test('extractTools: ignores functions without @mcp-expose', () => {
  const src = `/**\n * @description helper\n */\nasync function _helper(env) {}`;
  assert.equal(extractTools(src).length, 0);
});

test('extractTools: drops tools that production rejects and reports the reason', () => {
  const src = `/**\n * @mcp-expose\n * @description Invalid camelCase tool\n */\nasync function addNote(env) {}`;
  const result = extractToolsWithWarnings(src);
  assert.deepEqual(result.tools, []);
  assert.deepEqual(result.warnings, [{
    tool: 'addNote',
    issue: 'Tool name must be snake_case (lowercase letters, numbers, underscores only)',
    severity: 'error',
  }]);

  const messages = [];
  const original = console.error;
  console.error = (message) => messages.push(message);
  try {
    printDroppedTools(result.warnings);
  } finally {
    console.error = original;
  }
  assert.deepEqual(messages, [
    "Warning: MCP tool 'addNote' was dropped: Tool name must be snake_case (lowercase letters, numbers, underscores only)",
  ]);
});

test('vibe dev refuses a worker under src because production only builds a root worker', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-dev-nested-worker-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, '.vibe-coded.json'), JSON.stringify({ vibeSlug: 'demo', userSlug: 'tester' }));
  writeFileSync(join(root, 'src', 'worker.ts'), 'export default { fetch() {} };');
  try {
    const result = spawnSync(process.execPath, [join(RUNTIME_DIR, 'dev-server.mjs')], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /move the worker to the project root/);
    assert.match(result.stderr, /Production only builds a root worker/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildMfOptions binds the per-run vibe access token', () => {
  const token = 'a'.repeat(64);
  const options = buildMfOptions('/tmp/vibe-dev-test', {
    vibeId: '1',
    vibeSlug: 'app',
    userSlug: 'alice',
  }, { USER_SECRET: 'local-secret', PLATFORM_VIBE_TOKEN: 'forged-dev-var' }, token);

  assert.equal(options.bindings.PLATFORM_VIBE_TOKEN, token);
});

test('withDispatchHeaders proves write mode with the per-run token', () => {
  const token = 'b'.repeat(64);
  const headers = withDispatchHeaders({
    'x-vibe-access-mode': 'read',
    'x-vibe-access-token': 'client-forged-token',
  }, {
    vibeId: '1',
    vibeSlug: 'app',
    userSlug: 'alice',
  }, token);

  assert.equal(headers.get('x-vibe-access-mode'), 'write');
  assert.equal(headers.get('x-vibe-access-token'), token);
});

// vibe dev forwards only the headers production's dispatch forwards.
const CLIENT_HEADERS = {
  Accept: 'application/json',
  Authorization: 'Bearer secret',
  Cookie: 'vc_session=abc',
  'X-Random': 'nope',
  'Stripe-Signature': 't=1,v1=abc',
  'X-Webhook-Token': 'shared-secret',
  'x-mcp-call': 'true',
  'x-forwarded-for': '1.2.3.4',
  'cf-connecting-ip': '1.2.3.4',
};
const DEV_CONTEXT_HEADERS = ['x-client-ip', 'x-request-id', 'x-vibe-access-mode', 'x-vibe-access-token',
  'x-vibe-env', 'x-vibe-id', 'x-vibe-slug', 'x-vibe-user-slug'];

test('withDispatchHeaders forwards only the production allowlist (2r8e.84)', () => {
  const headers = withDispatchHeaders(CLIENT_HEADERS, { vibeId: '1', vibeSlug: 'app', userSlug: 'alice' }, 'c'.repeat(64));
  assert.deepEqual([...headers.keys()].sort(),
    ['accept', 'stripe-signature', 'x-webhook-token', ...DEV_CONTEXT_HEADERS].sort());
  assert.equal(headers.get('stripe-signature'), 't=1,v1=abc');
  assert.equal(headers.get('x-webhook-token'), 'shared-secret');
});

test('withDispatchHeaders keeps headers vibe dev adds itself, such as x-mcp-call on tool calls', () => {
  const headers = withDispatchHeaders({ 'content-type': 'application/json' },
    { vibeId: '1', vibeSlug: 'app', userSlug: 'alice' }, 'c'.repeat(64), { 'x-mcp-call': 'true' });
  assert.equal(headers.get('x-mcp-call'), 'true');
  assert.equal(headers.get('content-type'), 'application/json');
});

test('withDispatchHeaders keeps a request id vibe dev supplies itself, and drops a client one', () => {
  const manifest = { vibeId: '1', vibeSlug: 'app', userSlug: 'alice' };
  const own = withDispatchHeaders({}, manifest, 'c'.repeat(64), { 'x-request-id': 'dev-internal-1' });
  assert.equal(own.get('x-request-id'), 'dev-internal-1');
  const client = withDispatchHeaders({ 'x-request-id': 'client-forged' }, manifest, 'c'.repeat(64));
  assert.match(client.get('x-request-id'), /^dev-\d+$/);
});

test('vibe dev drops Authorization, Cookie and unknown headers before the worker sees them', async (t) => {
  const { root, runtimeDir, project } = setupDevRuntime();
  // Miniflare stub that echoes the headers the worker would receive.
  writeFileSync(join(root, 'skill', 'node_modules', 'miniflare', 'index.js'), `
    export class Miniflare {
      async dispatchFetch(url, init) {
        return Response.json(Object.fromEntries(new Headers(init.headers)));
      }
      async dispose() {}
      async setOptions() {}
    }
  `);
  let port;
  try {
    port = await getFreePort();
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    if (error?.code === 'EPERM') { t.skip('loopback binding is not permitted in this environment'); return; }
    throw error;
  }
  const child = spawn(process.execPath, [realpathSync(join(runtimeDir, 'dev-server.mjs')), '--port', String(port)], {
    cwd: project, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolveStarted, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start\n${output}`)), 10000);
    child.stdout.on('data', () => {
      if (output.includes('Watching worker for changes')) { clearTimeout(timer); resolveStarted(); }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code})\n${output}`)); });
  });

  const seen = await (await fetch(`http://127.0.0.1:${port}/api/hook`, { method: 'POST', headers: CLIENT_HEADERS, body: '{}' })).json();
  for (const name of ['authorization', 'cookie', 'x-random', 'x-mcp-call', 'x-forwarded-for', 'cf-connecting-ip', 'host']) {
    assert.equal(seen[name], undefined, `${name} reached the worker`);
  }
  assert.equal(seen['stripe-signature'], 't=1,v1=abc');
  assert.equal(seen['x-webhook-token'], 'shared-secret');
  assert.equal(seen.accept, 'application/json');
  child.kill('SIGTERM');
  await new Promise(resolveExit => child.once('exit', resolveExit));
});

test('vendored dispatch-header-policy.mjs is byte-identical to the platform copy', (t) => {
  const canonical = resolve(RUNTIME_DIR, '../../../src/services/dispatch-header-policy.mjs');
  if (!existsSync(canonical)) { t.skip('not running inside the platform repo'); return; }
  assert.ok(readFileSync(join(RUNTIME_DIR, 'dispatch-header-policy.mjs')).equals(readFileSync(canonical)),
    'skills/vibe-coded-ai/runtime/dispatch-header-policy.mjs drifted from src/services/; cp the platform copy over it');
});

test('vibe preview prunes remote files absent from the upload manifest', () => {
  const result = runPreview();

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Removed remote file: stale\.html/);
  assert.match(result.calls, /POST\thttps:\/\/stub\.invalid\/api\/v1\/vibes\/tester\/demo\/source\t.*"deletePaths":\["stale\.html"\]/);
  assert.doesNotMatch(result.calls, /^DELETE\t[^\n]*\/source\t/m);
  assert.equal((result.calls.match(/^POST\t[^\n]*\/source\t/gm) || []).length, 1);
  assert.doesNotMatch(result.calls, /state\.json/);
});

test('vibe preview never uploads a .git file (worktree / submodule)', () => {
  const result = runPreview([], 'gitfile');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls, /"index\.html":/);
  assert.doesNotMatch(result.calls, /"\.git":/);
});

test('vibe preview excludes .gitignore and lists every uploaded filename for a small upload', () => {
  const result = runPreview([], 'uploadnames');
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.calls, /"(?:assets\/)?\.gitignore":/);
  assert.match(result.stdout, /Uploaded 3 files\. With no build step/);
  for (const path of ['index.html', 'assets/style.css', 'file with spaces.txt']) {
    assert.ok(result.stdout.includes(`  ${path}\n`), result.stdout);
  }
  assert.doesNotMatch(result.stdout, /…and/);
});

test('vibe preview lists at most 20 filenames and reports the remaining count', () => {
  for (const [scenario, count] of [['upload20', 20], ['upload21', 21]]) {
    const result = runPreview([], scenario);
    assert.equal(result.status, 0, result.stderr);
    const upload = result.calls.split('\n').find(line => line.startsWith('POST\t') && line.includes('/source\t'));
    const paths = Object.keys(JSON.parse(upload.split('\t')[2]).files).sort();
    const listed = result.stdout.split('\n').filter(line => paths.includes(line.trim())).map(line => line.trim());
    assert.equal(paths.length, count);
    assert.deepEqual(listed, paths.slice(0, 20));
    if (count === 20) assert.doesNotMatch(result.stdout, /…and/);
    else assert.match(result.stdout, /…and 1 more/);
  }
});

test('vibe preview never uploads agent/editor folders, but keeps .well-known and build dotfiles', () => {
  const result = runPreview([], 'dotdirs');

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.calls, /"\.(claude|cursor|codex|vscode)\//);
  assert.match(result.calls, /"\.well-known\/security\.txt":/);
  assert.match(result.calls, /"public\/\.well-known\/assetlinks\.json":/);  // Vite copies public/ into dist/
  assert.match(result.calls, /"\.npmrc":/);                                   // build config still uploads
});

test('vibe preview never uploads local secrets or SQL seed files', () => {
  const result = runPreview([], 'localfiles');

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.calls, /\.dev\.vars|schema\.sql|do-not-upload|private_data/);
});

test('vibe preview excludes root agent notes but uploads build inputs and nested Markdown', () => {
  const result = runPreview([], 'agentnotes');

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.calls, /"(?:AGENTS|claude|GEMINI|MODEL|review-MODEL|OBSERVATIONS|SPEC|TODO|NOTES|README)\.md":/);
  assert.match(result.calls, /"worker\.ts":/);
  assert.match(result.calls, /"package\.json":/);
  assert.match(result.calls, /"tsconfig\.json":/);
  assert.match(result.calls, /"content\/posts\/MODEL\.md":/);
  assert.match(result.calls, /"guide\.md":/);
});

// The readable list leaves out what the platform never serves
// (isRootStaticFileExcluded + lockfiles at any depth), though they upload.
test('vibe preview does not list never-served files as readable', () => {
  const result = runPreview([], 'neverserved');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls, /"package\.json":/);   // still uploaded (build input)
  const listed = result.stdout.split('\n').filter(line => line.startsWith('  ')).map(line => line.trim());
  for (const hidden of ['package.json', 'bun.lock', 'wrangler.toml', 'tsconfig.json', 'sub/yarn.lock']) {
    assert.ok(!listed.includes(hidden), `${hidden} listed: ${result.stdout}`);
  }
  assert.ok(listed.includes('data/plants.json'), result.stdout);
  assert.ok(listed.includes('sub/package.json'), result.stdout);
});

test('vibe preview without dist/ says every uploaded file is publicly readable', () => {
  const result = runPreview([], 'uploadnames');

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('Uploaded 3 files. With no build step, the files below are publicly readable at their paths (any the worker imports are bundled and not served):\n'), result.stdout);
  assert.doesNotMatch(result.stdout, /only dist\/ is served/);
  assert.equal(result.stderr.includes('Warning'), false, result.stderr);
});

test('vibe preview describes file access using the vibe visibility and reuses the detail lookup', () => {
  for (const visibility of ['private', 'public', 'unlisted']) {
    for (const nested of [false, true]) {
      const detail = { visibility, mcpToolCount: 0 };
      const result = runPreview([], 'uploadnames', { success: true, ...(nested ? { vibe: detail } : detail) });
      assert.equal(result.status, 0, result.stderr);
      const access = visibility === 'private'
        ? 'readable at their paths by anyone who can open this vibe'
        : 'publicly readable at their paths';
      assert.ok(result.stdout.includes(`the files below are ${access} (any the worker imports are bundled and not served):`), result.stdout);
      if (visibility === 'private') assert.doesNotMatch(result.stdout, /publicly readable/);
      assert.equal((result.calls.match(/^GET\thttps:\/\/stub\.invalid\/api\/v1\/vibes\/tester\/demo\t/gm) || []).length, 1);
    }
  }
});

test('vibe preview still uploads when the vibe-details lookup fails', () => {
  const result = runPreview([], 'status500');
  assert.match(result.calls, /^POST\t[^\n]*\/source\t/m);
  assert.match(result.stdout, /anyone who can open this vibe \(public vibes: anyone\)/);
});

test('vibe preview with an unknown visibility still uploads, with neutral wording', () => {
  const result = runPreview([], 'normal', { success: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /anyone who can open this vibe \(public vibes: anyone\)/);
  assert.match(result.calls, /^POST\t[^\n]*\/source\t/m);
});

test('vibe preview with a build step says only the built dist/ is served and never uploads dist/', () => {
  const result = runPreview([], 'withdist');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /the platform runs your build and serves only its dist\/ output/);
  assert.doesNotMatch(result.stdout, /With no build step/);
  assert.doesNotMatch(result.calls, /"dist\//);
});

test('a local dist/ without a build step does not change the contract (dist/ is never uploaded)', () => {
  const result = runPreview([], 'staledist');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /publicly readable at their paths/);
});

test('vibe preview refuses ambiguous root worker.ts + worker.js before any request', () => {
  const result = runPreview([], 'dualworker');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Both worker\.ts and worker\.js exist/);
  assert.equal(result.calls, '');
});

test('vibe preview refuses an active build before saying files were uploaded', () => {
  const result = runPreview([], 'pendingpreflight');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Build 43 is still building/);
  assert.doesNotMatch(result.stdout, /Upload(?:ing|ed)/);
  assert.doesNotMatch(result.calls, /^POST\t[^\n]*\/source\t/m);
});

test('vibe init creates private invite-only vibes and protects local state in .gitignore', () => {
  const result = runCli('init', ['fresh-vibe']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls, /POST\thttps:\/\/stub\.invalid\/api\/v1\/vibes\t/);
  assert.match(result.calls, /"visibility": "private"/);
  assert.match(result.calls, /"interactionPolicy": "invite_only"/);
  assert.equal(result.gitignore, '.vibe-coded/\n.dev.vars\n');
});

test('vibe init rejects public and unlisted before any request and accepts private as a no-op', () => {
  for (const visibility of ['public', 'unlisted']) {
    const result = runCli('init', ['fresh-vibe', '--visibility', visibility]);
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), 'Set visibility on the website after init: https://vibe-coded.ai/account (vibe settings). init creates private vibes.');
    assert.equal(result.calls, '');
  }
  const result = runCli('init', ['fresh-vibe', '--visibility', 'private']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls, /"visibility": "private"/);
  assert.doesNotMatch(result.calls, /^PATCH\t/m);
  const help = runCli('init', ['--help']);
  assert.match(help.stdout, /--visibility private/);
  assert.doesNotMatch(help.stdout, /public|unlisted/);
});

test('vibe init renders a vibe-cap response through the plan gate', () => {
  const result = runCli('init', ['fresh-vibe'], 'vibecap');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Vibe limit reached \(5\/5\)/);
  assert.match(result.stderr, /Pro \(\$9\/mo\).*Pro\+ \(\$20\/mo\)/);
  assert.match(result.stderr, /https:\/\/vibe-coded\.ai\/account/);
  assert.match(result.stderr, /Tell your agent:.*then retry vibe init fresh-vibe\./);
  assert.equal(result.stderr.trim().split('\n').length, 1);
  assert.doesNotMatch(result.stderr, /Limit reached on the free plan/);
});

test('vibe init prints one agent instruction with every original option on a vibe cap', () => {
  const args = ['fresh-vibe', '--template', 'tracker', '--title', 'Fresh Tracker', '--visibility', 'private', '--storage', 'kv'];
  for (const scenario of ['vibecap', 'vibecapbyov', 'vibecappro']) {
    const result = runCli('init', args, scenario);

    assert.equal(result.status, 1, result.stderr);
    assert.equal((result.stderr.match(/Tell your agent:/g) || []).length, 1, result.stderr);
    assert.match(result.stderr, /Tell your agent:.*--template tracker/);
    const retryCommand = result.stderr.match(/then retry (vibe init .*?)(?:\.?)"\s*$/)?.[1];
    assert.ok(retryCommand, result.stderr);
    const replay = spawnSync('bash', ['-c', `vibe() { printf '%s\\0' "$@"; }\n${retryCommand}`], { encoding: 'utf8' });
    assert.equal(replay.status, 0, replay.stderr);
    assert.deepEqual(replay.stdout.split('\0').slice(0, -1), ['init', ...args]);
  }
});

test('vibe-cap guidance only names plans that raise the limit', () => {
  const pro = runCli('init', ['fresh-vibe'], 'vibecappro');
  assert.equal(pro.status, 1);
  assert.doesNotMatch(pro.stderr, /Pro \(\$9|upgrade/i);
  assert.match(pro.stderr, /Pro\+ is the highest plan/);
  assert.match(pro.stderr, /Tell your agent:.*free up room/);

  const byov = runCli('init', ['fresh-vibe'], 'vibecapbyov');
  assert.equal(byov.status, 1);
  assert.doesNotMatch(byov.stderr, /Pro \(\$9/);
  assert.match(byov.stderr, /billing\?plan=pro/);
  assert.match(byov.stderr, /upgrade my vibe-coded.ai plan to Pro\+/);
});

test('vibe init rejects platform-invalid slugs before making an API call', () => {
  for (const slug of ['my--app', 'trailing-', 'a'.repeat(64)]) {
    const result = runCli('init', [slug]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no '--' or trailing hyphen/);
    assert.equal(result.calls, '');
  }
});

test('vibe init owner/slug points a collaborator to that vibe\'s MCP URL without an API call', () => {
  const result = runCli('init', ['alice/demo', '--adopt']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /vibe init works on vibes you own/);
  assert.match(result.stderr, /https:\/\/alice--demo\.vibe-coded\.ai\/mcp/);
  assert.match(result.stderr, /run: vibe connect alice\/demo/);
  assert.equal(result.calls, '');
});

test('vibe init with your own owner/slug behaves like a plain slug', () => {
  const result = runCli('init', ['tester/fresh-vibe']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls, /"slug": "fresh-vibe"/);
});

test('commands without a manifest explain shared-vibe MCP access without inventing a URL', () => {
  const result = runCli('preview', [], 'nomanifest');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Run 'vibe init <slug>' first/);
  assert.match(result.stderr, /vibe preview works on vibes you own/);
  assert.match(result.stderr, /run: vibe connect <owner>\/<slug>/);
  assert.doesNotMatch(result.stderr, /https:\/\/.*--.*\.vibe-coded\.ai\/mcp/);
});

test('vibe call makes a real MCP tools/call on the production vibe and prints the result', () => {
  const result = runCli('call', ['add_note', '{"text":"hi"}']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\{"success":true\}/);
  assert.match(result.calls, /POST\thttps:\/\/tester--demo\.vibe-coded\.ai\/mcp\t.*"method":"tools\/call".*"name":"add_note".*"text":"hi"/);
});

test('vibe call --preview targets the preview host; tool errors and unknown tools exit 1', () => {
  assert.match(runCli('call', ['list_notes', '--preview']).calls, /https:\/\/p--tester--demo\.vibe-coded\.ai\/mcp/);
  const failing = runCli('call', ['failing_tool']);
  assert.equal(failing.status, 1);
  assert.match(failing.stdout, /bad input/);
  const unknown = runCli('call', ['no_such_tool']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Tool not found/);
});

test('vibe preview prints the preview build MCP tool count', () => {
  const result = runPreview([], 'withworker');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MCP Tools:\s+17/);
  assert.doesNotMatch(result.stdout, /MCP Tools:\s+14/);
});

test('vibe preview falls back to mcpToolCount from older API responses', () => {
  const result = runPreview([], 'withworker', { success: true, visibility: 'private', mcpToolCount: 9 });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MCP Tools:\s+9/);
});

test('vibe status prints preview and production MCP tool counts when they differ', () => {
  const result = runCli('status', [], 'withworker');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MCP Tools:\s+17 preview · 14 production — run vibe publish/);
  assert.match(result.stdout, /Preview:\s+build 42/);
  assert.match(result.stdout, /Production: build 40/);
});

test('static vibes omit MCP warnings, endpoints and connection instructions on preview, publish and status', () => {
  for (const command of ['preview', 'publish', 'status']) {
    const result = runCli(command, [], 'normal', {
      success: true, vibe: { visibility: 'private', previewBuildId: 42, productionBuildId: 40, mcpToolCount: 0 },
    });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    assert.doesNotMatch(result.stdout + result.stderr, /MCP|@mcp-expose|vibe connect|\/mcp|Connectors/);
    assert.match(result.stdout, /https:\/\/(?:p--)?tester--demo\.vibe-coded\.ai/);
  }
});

test('worker vibes keep MCP endpoints, warnings and production connection instructions', () => {
  for (const command of ['preview', 'publish', 'status']) {
    const result = runCli(command, [], 'withworker', {
      success: true, vibe: { visibility: 'private', previewBuildId: 42, productionBuildId: 40, mcpToolCount: 0 },
    });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    assert.match(result.stdout, /MCP:\s+https:\/\//);
    if (command === 'preview' || command === 'status') assert.match(result.stderr, /Warning: no MCP tools/);
    if (command === 'publish' || command === 'status') assert.match(result.stdout, /vibe connect/);
  }
});

test('vibe urls labels preview URLs and only prints production URLs after publishing', () => {
  for (const detail of [
    { success: true, vibe: { previewBuildId: 42, productionBuildId: null } },
    { success: true, previewBuildId: 42 },
  ]) {
    const result = runCli('urls', [], 'withworker', detail);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Production: not published yet \(run vibe publish\)/);
    assert.match(result.stdout, /Preview:\s+https:\/\/p--tester--demo\.vibe-coded\.ai/);
    assert.doesNotMatch(result.stdout, /App:\s+https:\/\/p--|https:\/\/tester--demo\.vibe-coded\.ai|vibe connect/);
  }
  for (const detail of [
    { success: true, vibe: { productionBuildId: 40 } },
    { success: true, productionBuildId: 40 },
  ]) {
    const result = runCli('urls', [], 'withworker', detail);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /App:\s+https:\/\/tester--demo\.vibe-coded\.ai/);
    assert.match(result.stdout, /vibe connect/);
    assert.doesNotMatch(result.stdout, /not published yet|App:\s+https:\/\/p--/);
  }
});

test('vibe urls fails when publication status cannot be fetched', () => {
  for (const scenario of ['netdown', 'status401', 'status403', 'status500']) {
    const result = runCli('urls', [], scenario);
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stdout, /https:\/\/tester--demo\.vibe-coded\.ai|not published yet/);
  }
});

test('completed login tells users which recorded connections need new tokens', () => {
  const result = runCli('login', ['--finish'], 'loginconnected');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /If a connection shows HTTP 401, re-run vibe connect for: alice\/notes, tester\/demo/);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-old-demo|synthetic-old-notes|Authorization:/);
  assert.equal(Object.keys(result.connections).length, 2);
});

test('login without connections, a denied login and login --start omit the reconnect notice', () => {
  for (const [scenario, args, status] of [
    ['normal', ['--finish'], 0],
    ['loginempty', ['--finish'], 0],
    ['logindenied', ['--finish'], 1],
    ['loginstart', ['--start'], 0],
  ]) {
    const result = runCli('login', args, scenario);
    assert.equal(result.status, status, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /re-run vibe connect/);
  }
});

test('vibe publish leaves a failed build to the platform: relays its 409, and publishes once the source was restored (2r8e.24)', () => {
  const failed = runCli('publish', [], 'publishfailed');
  assert.equal(failed.status, 1);
  assert.match(failed.calls, /^POST\t[^\n]*\/publish\t/m);
  assert.match(failed.stderr, /Preview build 43 failed: worker\.js:2:24/);
  assert.match(failed.stderr, /vibe logs 43/);

  // Latest build failed, but the source was restored: the platform publishes.
  const restored = runCli('publish', [], 'publishrestored');
  assert.equal(restored.status, 0);
  assert.match(restored.calls, /^POST\t[^\n]*\/publish\t/m);
  assert.match(restored.stdout, /Published!|may not be live yet/);
});

test('vibe status prints API errors and exits non-zero', () => {
  const unauthorized = runCli('status', [], 'status401');
  assert.equal(unauthorized.status, 1);
  assert.match(unauthorized.stderr, /Your login expired or was revoked — run: vibe login/);
  assert.doesNotMatch(unauthorized.stdout, /unknown|run 'vibe preview'/);

  for (const [scenario, message] of [['status403', 'access denied'], ['status500', 'service unavailable']]) {
    const result = runCli('status', [], scenario);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`Status failed: ${message}`));
    assert.doesNotMatch(result.stdout, /unknown|run 'vibe preview'/);
  }
});

test('authenticated commands map every HTTP 401 to the revoked-login message', () => {
  for (const [command, args] of [
    ['preview', []],
    ['publish', []],
    ['call', ['list_notes']],
    ['secrets', ['list']],
  ]) {
    const result = runCli(command, args, 'auth401');
    assert.equal(result.status, 1, `${command}: ${result.stderr}`);
    assert.match(result.stderr, /Your login expired or was revoked — run: vibe login/);
    assert.doesNotMatch(result.stderr, /Authentication required/);
    assert.doesNotMatch(result.stderr, /reach the API|network error/, `${command}: a 401 is not a network failure`);
  }
});

test('vibe preview requires --prune when more than half the remote files would be removed', () => {
  const guarded = runPreview([], 'guard');
  assert.notEqual(guarded.status, 0);
  assert.match(guarded.stderr, /Pruning would remove 2 of 3 remote source files/);
  assert.doesNotMatch(guarded.calls, /^DELETE\t/m);

  const confirmed = runPreview(['--prune'], 'guard');
  assert.equal(confirmed.status, 0, confirmed.stderr);
  assert.match(confirmed.stdout, /Removed remote file: old-a\.html/);
  assert.match(confirmed.stdout, /Removed remote file: old-b\.html/);
  assert.match(confirmed.calls, /"deletePaths":\["old-a\.html","old-b\.html"\]/);
  assert.doesNotMatch(confirmed.calls, /^DELETE\t/m);
});

test('vibe preview requires --prune when more than 20 remote files would be removed', () => {
  const result = runPreview([], 'over20');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Pruning would remove 21 of 47 remote source files/);
  assert.doesNotMatch(result.calls, /^DELETE\t/m);
});

test('vibe preview fails closed when the remote source listing is invalid', () => {
  const result = runPreview([], 'invalid');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Remote source listing was invalid; no files were pruned/);
  assert.doesNotMatch(result.calls, /^DELETE\t/m);
});

test('vibe preview --no-prune skips listing and deletion', () => {
  const result = runPreview(['--no-prune']);

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.calls, /^GET\t[^\n]*\/source\?/m);
  assert.doesNotMatch(result.calls, /^DELETE\t/m);
});

test('ipv6PortTaken detects another program on the same port over IPv6 (localhost → ::1)', async (t) => {
  const { createServer: netServer } = await import('node:net');
  const other = netServer();
  const listening = await new Promise((resolveL) => {
    other.once('error', () => resolveL(false));
    other.listen(0, '::1', () => resolveL(true));
  });
  if (!listening) { t.skip('no IPv6 loopback on this machine'); return; }
  const port = other.address().port;
  try {
    assert.equal(await ipv6PortTaken(port), true);
  } finally {
    await new Promise((r) => other.close(r));
  }
  assert.equal(await ipv6PortTaken(port), false);
});

test('vibe call on a vibe that was never published says so and how to fix it', () => {
  const prod = runCli('call', ['unbuilt_tool']);
  assert.equal(prod.status, 1);
  assert.match(prod.stderr, /Not published yet — run: vibe preview, then vibe publish/);
  const prev = runCli('call', ['unbuilt_tool', '--preview']);
  assert.match(prev.stderr, /No preview build yet — run: vibe preview/);
  // The platform's real shape: JSON-RPC error object.
  const rpc = runCli('call', ['unbuilt_rpc']);
  assert.equal(rpc.status, 1);
  assert.match(rpc.stderr, /Error: Vibe not found/);
  assert.match(rpc.stderr, /Not published yet/);
});

test('vibe fetch reads a private deployed path with the owner token transport', () => {
  const production = runCli('fetch', ['/docs/guide.html']);
  assert.equal(production.status, 0, production.stderr);
  assert.match(production.stdout, /private owner view/);
  assert.match(production.calls, /^GET\thttps:\/\/tester--demo\.vibe-coded\.ai\/docs\/guide\.html\t/m);
  assert.doesNotMatch(production.calls, /synthetic-test-token/);

  const preview = runCli('fetch', ['image.png', '--preview']);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.calls, /^GET\thttps:\/\/p--tester--demo\.vibe-coded\.ai\/image\.png\t/m);
});

test('vibe fetch says the login expired on 401 and reports other HTTP errors', () => {
  const expired = runCli('fetch', ['/x'], 'fetch401');
  assert.equal(expired.status, 1);
  assert.match(expired.stderr, /Your login expired or was revoked — run: vibe login/);
  assert.equal(expired.stdout, '');

  const missing = runCli('fetch', ['/x'], 'fetch404');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /HTTP 404/);
  assert.equal(missing.stdout, '');
});

test('vibe preview names each rejected file instead of "unknown"', () => {
  const result = runPreview([], 'rejected');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /init\.log: File type \.log not allowed/);
  assert.doesNotMatch(result.stderr, /unknown/);
});

test('vibe preview prints build-limit guidance once and exits non-zero', () => {
  const result = runPreview([], 'buildlimit');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Free allows 10 builds an hour\. Your next build is available in 14 minutes \(at 14:32 UTC\)\./);
  assert.match(result.stderr, /Keep iterating with `vibe dev`, which has no build limit\./);
  assert.match(result.stderr, /Don't retry before 14:32 UTC\./);
  assert.doesNotMatch(result.stderr, /Upload failed:/);
  assert.equal((result.calls.match(/^POST\thttps:\/\/stub\.invalid\/api\/v1\/vibes\/tester\/demo\/source\t/gm) || []).length, 1);
});

test('vibe connect mints a vibe-only token, retires the old one, and registers it with Claude Code', () => {
  const r = runCli('connect', [], 'connected');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.calls, /^POST\thttps:\/\/stub\.invalid\/api\/v1\/vibes\/tester\/demo\/mcp-tokens\t/m);
  assert.match(r.calls, /^DELETE\thttps:\/\/stub\.invalid\/api\/v1\/vibes\/tester\/demo\/mcp-tokens\/old-jti\t/m);
  assert.match(r.calls, /^claude\tmcp remove demo -s user$/m);
  assert.match(r.calls, /^claude\tmcp add --transport http -s user demo https:\/\/tester--demo\.vibe-coded\.ai\/mcp --header Authorization: Bearer conn-tok$/m);
  assert.match(r.stdout, /Connected 'demo'/);
  assert.match(r.calls, /^claude\tmcp get demo$/m);
  assert.match(r.stdout, /Check: ✔ Connected/);
  assert.doesNotMatch(r.stdout, /conn-tok/);
  assert.deepEqual(r.connections, { 'tester--demo': { jti: 'new-jti', expiresAt: '2026-12-26T00:00:00.000Z', name: 'demo' } });
  // The deploy token is only ever sent to the API, never handed to Claude Code.
  assert.doesNotMatch(r.calls, /synthetic-test-token/);
});

test('vibe connect prints the command when Claude Code is not installed', () => {
  const r = runCli('connect', [], 'noclaude');
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.calls, /^claude\t/m);
  assert.match(r.stdout, /not on PATH/);
  assert.match(r.stdout, /claude mcp add --transport http -s user demo https:\/\/tester--demo\.vibe-coded\.ai\/mcp --header "Authorization: Bearer conn-tok"/);
});

test('vibe connect --print preserves an existing Claude Code token and records the new one', () => {
  const r = runCli('connect', ['--print', '--name', 'new-name'], 'connected');
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.calls, /^DELETE\t|^claude\t/m);
  assert.match(r.stdout, /claude mcp add --transport http -s user new-name /);
  assert.ok(r.stdout.includes("Your existing Claude Code connection 'demo' keeps working with its current token; run the command above to switch it, then `vibe connect --revoke` removes the old one."));
  assert.deepEqual(r.connections['tester--demo'], {
    jti: 'old-jti', expiresAt: '2026-10-01T00:00:00.000Z', name: 'demo', additionalJtis: ['new-jti'],
  });
});

test('vibe connect --revoke and plain connect retire every recorded token', () => {
  for (const args of [['--revoke'], []]) {
    const r = runCli('connect', args, 'multiconnected');
    assert.equal(r.status, 0, r.stderr);
    for (const jti of ['old-jti', 'printed-jti', 'another-jti']) {
      assert.ok(r.calls.includes(`/mcp-tokens/${jti}\t`), r.calls);
    }
    if (args.length) assert.deepEqual(r.connections, {});
    else assert.deepEqual(r.connections['tester--demo'], {
      jti: 'new-jti', expiresAt: '2026-12-26T00:00:00.000Z', name: 'demo',
    });
  }
});

test('vibe connect surfaces a refused mint and changes nothing', () => {
  const r = runCli('connect', [], 'mintfail');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Only the owner can connect this vibe/);
  assert.doesNotMatch(r.calls, /^claude\t/m);
  assert.equal(r.connections, null);
});

test('vibe connect revokes the new token when claude mcp add fails', () => {
  const r = runCli('connect', [], 'claudefail');
  assert.equal(r.status, 1);
  assert.match(r.calls, /^DELETE\t[^\t]*\/mcp-tokens\/new-jti\t/m);
  assert.deepEqual(r.connections, {});
});

test('vibe connect --revoke revokes the recorded token and removes the server', () => {
  const r = runCli('connect', ['--revoke'], 'connected');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.calls, /^DELETE\t[^\t]*\/mcp-tokens\/old-jti\t/m);
  assert.match(r.calls, /^claude\tmcp remove demo -s user$/m);
  assert.deepEqual(r.connections, {});
  const none = runCli('connect', ['--revoke']);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /No connection recorded/);
});

test('vibe connect rejects unsafe names and other clients', () => {
  assert.match(runCli('connect', ['--name', 'a b;rm']).stderr, /--name may use/);
  assert.match(runCli('connect', ['--client', 'claude-ai']).stderr, /only --client claude-code/);
  const missing = runCli('connect', ['--name']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Error: --name requires a value/);
});

test('vibe connect never replaces an unrelated Claude Code server with the same name', () => {
  const clash = runCli('connect', [], 'nameclash');
  assert.equal(clash.status, 1);
  assert.match(clash.stderr, /already has a server named 'demo' \(https:\/\/mcp\.example\.com\/mcp\)/);
  assert.doesNotMatch(clash.calls, /mcp-tokens|^claude\t/m);
  // The same vibe added earlier (e.g. via OAuth) is replaced.
  const same = runCli('connect', [], 'samevibe');
  assert.equal(same.status, 0, same.stderr);
  assert.match(same.calls, /^claude\tmcp add /m);
});

test('vibe connect fails loudly when Claude Code cannot reach the vibe', () => {
  const r = runCli('connect', [], 'unreachable');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Check failed: ✘ Failed to connect HTTP 404/);
  assert.match(r.stderr, /Is the vibe published\?/);
});

test('needsViteBuild spots Vite apps that vibe dev cannot render (2r8e.9)', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-vite-detect-'));
  try {
    const mk = (name, files) => {
      const d = join(root, name);
      mkdirSync(d);
      for (const [f, c] of Object.entries(files)) writeFileSync(join(d, f), c);
      return d;
    };
    assert.equal(needsViteBuild(mk('config', { 'vite.config.ts': 'export default {}', 'index.html': '<div id="app"></div>' })), true);
    assert.equal(needsViteBuild(mk('ts-entry', { 'index.html': '<script type="module" src="/src/main.ts"></script>' })), true);
    assert.equal(needsViteBuild(mk('cjs', { 'vite.config.cjs': 'module.exports = {}' })), true);
    assert.equal(needsViteBuild(mk('plain', { 'index.html': '<script src="/app.js"></script>' })), false);
    assert.equal(needsViteBuild(mk('worker-only', { 'worker.js': '' })), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every CLI command accepts -h/--help without credentials or side effects', () => {
  for (const command of ['login', 'logout', 'init', 'templates', 'dev', 'preview', 'publish', 'status', 'urls', 'fetch', 'call', 'connect', 'logs', 'settings', 'access', 'secrets', 'r2', 'delete']) {
    const result = runCli(command, ['--help']);
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    assert.match(result.stdout, /^Usage: vibe /);
    assert.ok(result.stdout.trim().split('\n').length > 1, `${command}: help should explain the command`);
    assert.equal(result.calls, '', command);
  }
});

test('settings help lists every interaction policy including public_read', () => {
  const result = runCli('settings', ['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--interaction public\|public_read\|authenticated\|invite_only/);
  assert.equal(result.calls, '');
});

test('nested CLI help never runs the subcommand', () => {
  for (const [command, args, usage] of [
    ['secrets', ['create', '--help'], 'vibe secrets create'],
    ['access', ['grant', '-h'], 'vibe access grant'],
    ['r2', ['upload', '--help'], 'vibe r2 upload'],
    ['dev', ['seed', '--help'], 'vibe dev seed'],
  ]) {
    const result = runCli(command, args);
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(`^Usage: ${usage}`));
    assert.equal(result.calls, '', command);
  }
});

test('web-only refusals print the dashboard link and exit non-zero', () => {
  for (const [command, args, panel] of [
    ['settings', ['--visibility', 'public'], 'settings'],
    ['settings', ['--interaction', 'public_read'], 'settings'],
    ['access', ['grant'], 'access'],
    ['delete', [], 'delete'],
  ]) {
    const result = runCli(command, args);
    assert.equal(result.status, 1, `${command}: ${result.stderr}`);
    assert.match(result.stderr, new RegExp(`panel=${panel}`));
  }
});

test('signed-out commands point people and agents to vibe login', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-cli-signed-out-'));
  try {
    const result = spawnSync('bash', [VIBE_BIN, 'status'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, HOME: join(root, 'home') },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Not signed in\. Run: vibe login   \(agents: vibe login --start, give the user the link, then vibe login --finish\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('vibe call supplies its bearer token through curl config stdin, not argv', () => {
  const cli = readFileSync(VIBE_BIN, 'utf8');
  const callBody = cli.slice(cli.indexOf('cmd_call()'), cli.indexOf('# vibe connect'));
  assert.match(callBody, /curl -sS -K -/);
  assert.doesNotMatch(callBody, /-H "Authorization: Bearer \$TOKEN"/);
});

test('vibe r2 url warns about the 120s cap and prints the actual expiry', () => {
  const result = runCli('r2', ['url', 'docs/manual.pdf', '--ttl', '3600']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /TTL is capped at 120 seconds/);
  assert.match(result.stdout, /https:\/\/signed\.invalid\/object/);
  assert.match(result.stdout, /Expires at: 1770000120/);
  assert.match(result.calls, /"ttl": 3600/);
});

test('vibe --version prints the skill version', () => {
  const version = JSON.parse(readFileSync(resolve(dirname(VIBE_BIN), '../package.json'), 'utf8')).version;
  for (const flag of ['--version', '-V', 'version']) {
    const r = spawnSync('bash', [VIBE_BIN, flag], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), `vibe ${version}`);
  }
});

test('a network failure is reported, not silent', () => {
  const r = runCli('status', [], 'netdown');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /could not reach .* \(network error\)/);
});

test('an expired login during upload is not reported as a network failure', () => {
  const result = runPreview([], 'upload401');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Your login expired or was revoked — run: vibe login/);
  assert.doesNotMatch(result.stderr, /reach the API|network error/);
});

test('the preview file list leaves out the root worker, which is never served', () => {
  const result = runPreview([], 'withworker');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /the files below are/);
  assert.doesNotMatch(result.stdout, /^ {2}worker\.js$/m);
  assert.match(result.calls, /"worker\.js":/);
});
