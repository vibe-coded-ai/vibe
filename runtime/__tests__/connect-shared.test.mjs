// `vibe connect <owner>/<slug>` for a vibe someone shared with you,
// and the owner/slug guidance in `vibe init` and the help text.
// Runs the real CLI with stub curl and Claude Code commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const VIBE_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'vibe');

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'vibe-connect-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const work = join(root, 'work');
  mkdirSync(join(home, '.vibe-coded'), { recursive: true });
  mkdirSync(bin);
  mkdirSync(work);
  writeFileSync(join(home, '.vibe-coded', 'credentials.json'), JSON.stringify({
    token: 'cli-login-token',
    userSlug: 'bob',
    apiUrl: 'https://api.vibe-coded.ai',
    expiresAt: '2099-01-01T00:00:00Z',
  }));
  // Answers POST with $STUB_BODY/$STUB_CODE and anything else with a revoke success.
  writeFileSync(join(bin, 'curl'), [
    '#!/usr/bin/env bash',
    'echo "$*" >> "$STUB_LOG"',
    'cat >/dev/null',
    'method=GET',
    'args=("$@")',
    'for ((i=0; i<${#args[@]}; i++)); do [ "${args[$i]}" = "-X" ] && method="${args[$((i+1))]}"; done',
    'if [ "$method" = "POST" ]; then printf "%s\\n%s" "$STUB_BODY" "$STUB_CODE";',
    'elif [ -n "$STUB_DEL_BODY" ]; then printf "%s\\n%s" "$STUB_DEL_BODY" "$STUB_DEL_CODE";',
    'else printf "%s\\n%s" \'{"success":true,"revoked":true}\' 200; fi',
  ].join('\n'), { mode: 0o755 });
  writeFileSync(join(bin, 'claude'), [
    '#!/usr/bin/env bash',
    'echo "claude $*" >> "$STUB_LOG"',
    'if [ "$2" = get ]; then echo "Status: ✔ Connected"; fi',
  ].join('\n'), { mode: 0o755 });
  const run = (args, { body, code = '200', delBody = '', delCode = '200' } = {}) => {
    const result = spawnSync('bash', [VIBE_BIN, ...args], {
      cwd: work,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        STUB_LOG: join(root, 'curl.log'),
        STUB_BODY: body ?? '',
        STUB_CODE: code,
        STUB_DEL_BODY: delBody,
        STUB_DEL_CODE: delCode,
        VIBE_NO_UPDATE_CHECK: '1',
      },
    });
    const log = join(root, 'curl.log');
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
    return { ...result, calls };
  };
  const connections = () => {
    const p = join(home, '.vibe-coded', 'connections.json');
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  };
  return { run, connections, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const MINTED = JSON.stringify({
  success: true,
  token: 'conn-token-123',
  jti: '11111111-2222-4333-8444-555555555555',
  expiresAt: '2026-12-30T00:00:00.000Z',
  url: 'https://alice--notes.vibe-coded.ai/mcp',
});

test('vibe connect <owner>/<slug> mints on the owner\'s vibe and prints the Claude Code command', () => {
  const { run, connections, cleanup } = setup();
  try {
    const r = run(['connect', 'alice/notes', '--print'], { body: MINTED });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.calls.some(c => c.includes('-X POST https://api.vibe-coded.ai/api/v1/vibes/alice/notes/mcp-tokens')), r.calls.join('\n'));
    assert.match(r.stdout, /claude mcp add --transport http -s user notes https:\/\/alice--notes\.vibe-coded\.ai\/mcp --header "Authorization: Bearer conn-token-123"/);
    assert.match(r.stdout, /Revoke: vibe connect alice\/notes --revoke/);
    assert.equal(connections()['alice--notes'].jti, '11111111-2222-4333-8444-555555555555');

    const revoked = run(['connect', 'alice/notes', '--revoke']);
    assert.equal(revoked.status, 0, revoked.stderr);
    assert.ok(revoked.calls.some(c => c.includes('-X DELETE https://api.vibe-coded.ai/api/v1/vibes/alice/notes/mcp-tokens/11111111-2222-4333-8444-555555555555')));
    assert.equal(connections()['alice--notes'], undefined);
  } finally {
    cleanup();
  }
});

test('vibe connect <owner>/<slug> explains a 404 (not shared with you)', () => {
  const { run, cleanup } = setup();
  try {
    const r = run(['connect', 'alice/notes', '--print'], { body: '{"success":false,"error":"Vibe not found"}', code: '404' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Vibe not found/);
    assert.match(r.stderr, /alice has shared notes with you/);
  } finally {
    cleanup();
  }
});

test('plain connect followed by repeated --print keeps the registered token until --revoke retires every token', () => {
  const { run, connections, cleanup } = setup();
  try {
    const first = run(['connect', 'alice/notes', '--name', 'working'], { body: MINTED });
    assert.equal(first.status, 0, first.stderr);
    const initial = connections()['alice--notes'];
    for (const jti of ['printed-one', 'printed-two']) {
      const result = run(['connect', 'alice/notes', '--print'], {
        body: JSON.stringify({ ...JSON.parse(MINTED), jti }),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes("Your existing Claude Code connection 'working' keeps working"));
      assert.equal(connections()['alice--notes'].jti, initial.jti);
      assert.equal(connections()['alice--notes'].name, 'working');
      assert.ok(connections()['alice--notes'].additionalJtis.includes(jti));
      assert.ok(result.calls.every(call => !call.includes('-X DELETE')));
      assert.equal(result.calls.filter(call => call.startsWith('claude mcp add ')).length, 1);
    }
    const revoked = run(['connect', 'alice/notes', '--revoke']);
    assert.equal(revoked.status, 0, revoked.stderr);
    for (const jti of [initial.jti, 'printed-one', 'printed-two']) {
      assert.equal(revoked.calls.filter(call => call.includes(`-X DELETE https://api.vibe-coded.ai/api/v1/vibes/alice/notes/mcp-tokens/${jti} `)).length, 1);
    }
    assert.ok(revoked.calls.includes('claude mcp remove working -s user'));
    assert.equal(connections()['alice--notes'], undefined);
  } finally {
    cleanup();
  }
});

test('vibe connect rejects a malformed owner/slug before any request', () => {
  const { run, cleanup } = setup();
  try {
    const r = run(['connect', 'Alice/notes', '--print'], { body: MINTED });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /invalid owner/);
    assert.equal(r.calls.length, 0);
  } finally {
    cleanup();
  }
});

test('vibe init <owner>/<slug> points a collaborator to vibe connect', () => {
  const { run, cleanup } = setup();
  try {
    const r = run(['init', 'alice/notes']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /run: vibe connect alice\/notes/);
    assert.match(r.stderr, /https:\/\/alice--notes\.vibe-coded\.ai\/mcp/);
  } finally {
    cleanup();
  }
});

test('connect and init help show the owner/slug form', () => {
  const { run, cleanup } = setup();
  try {
    assert.match(run(['connect', '--help']).stdout, /vibe connect \[<owner>\/<slug>\]/);
    assert.match(run(['init', '--help']).stdout, /vibe connect <owner>\/<slug>/);
  } finally {
    cleanup();
  }
});

test('vibe connect <owner>/<slug> --revoke cleans up locally after the owner removed access', () => {
  const { run, connections, cleanup } = setup();
  try {
    assert.equal(run(['connect', 'alice/notes', '--print'], { body: MINTED }).status, 0);
    const r = run(['connect', 'alice/notes', '--revoke'], { delBody: '{"success":false,"error":"Vibe not found"}', delCode: '404' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /token already stopped working/);
    assert.equal(connections()['alice--notes'], undefined);
  } finally {
    cleanup();
  }
});

test('a plain connect keeps a token it failed to revoke on record, so --revoke can retry it', () => {
  const { run, connections, cleanup } = setup();
  try {
    assert.equal(run(['connect', 'alice/notes', '--print'], { body: MINTED }).status, 0);
    const second = JSON.stringify({
      success: true, token: 'conn-token-456', jti: '22222222-3333-4444-8555-666666666666',
      expiresAt: '2026-12-30T00:00:00.000Z', url: 'https://alice--notes.vibe-coded.ai/mcp',
    });
    const r = run(['connect', 'alice/notes'], { body: second, delBody: '{"success":false,"error":"boom"}', delCode: '500' });
    assert.match(r.stderr, /could not revoke the previous connection token/);
    const rec = connections()['alice--notes'];
    assert.equal(rec.jti, '22222222-3333-4444-8555-666666666666');
    assert.deepEqual(rec.additionalJtis, ['11111111-2222-4333-8444-555555555555']);
  } finally {
    cleanup();
  }
});
