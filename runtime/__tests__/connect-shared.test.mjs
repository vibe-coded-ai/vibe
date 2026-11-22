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
  url: 'https://alice--notes.vibe-coded.app/mcp',
});

test('vibe connect <owner>/<slug> mints on the owner\'s vibe and prints the Claude Code command', () => {
  const { run, connections, cleanup } = setup();
  try {
    const r = run(['connect', 'alice/notes', '--print'], { body: MINTED });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.calls.some(c => c.includes('-X POST https://api.vibe-coded.ai/api/v1/vibes/alice/notes/mcp-tokens')), r.calls.join('\n'));
    assert.match(r.stdout, /claude mcp add --transport http -s user notes https:\/\/alice--notes\.vibe-coded\.app\/mcp --header "Authorization: Bearer conn-token-123"/);
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
    assert.match(r.stderr, /^Error: Vibe alice\/notes not found or not shared with you$/m);
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
    assert.match(r.stderr, /https:\/\/alice--notes\.vibe-coded\.app\/mcp/);
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

test('vibe connect <owner>/<slug> --revoke after the owner removed access says the tokens are suspended and keeps their record', () => {
  const { run, connections, cleanup } = setup();
  try {
    assert.equal(run(['connect', 'alice/notes', '--print'], { body: MINTED }).status, 0);
    const r = run(['connect', 'alice/notes', '--revoke'], { delBody: '{"success":false,"error":"Vibe not found"}', delCode: '404' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Revoked 0 connection token\(s\) for alice\/notes\.$/m);
    assert.match(r.stdout, /^Your access to alice\/notes was removed, so its remaining tokens could not be revoked\. They are suspended: they work again, with the role you are given, if alice shares notes with you again\. This machine keeps their record, so vibe connect alice\/notes --revoke can revoke them then; to end them now, use Revoke all at https:\/\/vibe-coded\.ai\/account\.$/m);
    assert.doesNotMatch(r.stdout, /already stopped working/);
    assert.equal(connections()['alice--notes'].jti, '11111111-2222-4333-8444-555555555555');
    assert.equal(connections()['alice--notes'].registered, false);
    assert.equal(connections()['alice--notes'].name, undefined);
    // The name is free for another connection now; a second revoke leaves Claude Code alone.
    const before = r.calls.length;
    const retry = run(['connect', 'alice/notes', '--revoke'], { delBody: '{"success":false,"error":"Vibe not found"}', delCode: '404' });
    assert.equal(retry.status, 0, retry.stderr);
    assert.deepEqual(retry.calls.slice(before).filter(call => call.startsWith('claude mcp remove')), []);
    // After a new grant the same record revokes the token.
    const again = run(['connect', 'alice/notes', '--revoke']);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /^Revoked 1 connection token\(s\) for alice\/notes\.$/m);
    assert.equal(connections()['alice--notes'], undefined);
  } finally {
    cleanup();
  }
});

test('after a new grant, connect --print replaces a kept record and --revoke then removes its registration', () => {
  const { run, connections, cleanup } = setup();
  try {
    assert.equal(run(['connect', 'alice/notes', '--print'], { body: MINTED }).status, 0);
    assert.equal(run(['connect', 'alice/notes', '--revoke'], { delBody: '{"success":false,"error":"Vibe not found"}', delCode: '404' }).status, 0);
    const second = JSON.stringify({
      success: true, token: 'conn-token-456', jti: '22222222-3333-4444-8555-666666666666',
      expiresAt: '2026-12-30T00:00:00.000Z', url: 'https://alice--notes.vibe-coded.app/mcp',
    });
    const printed = run(['connect', 'alice/notes', '--print'], { body: second });
    assert.equal(printed.status, 0, printed.stderr);
    assert.ok(printed.calls.some(call => call.includes('-X DELETE') && call.includes('mcp-tokens/11111111-2222-4333-8444-555555555555')), 'the suspended token is revoked once access is back');
    assert.doesNotMatch(printed.stdout, /keeps working with its current token/);
    const record = connections()['alice--notes'];
    assert.equal(record.jti, '22222222-3333-4444-8555-666666666666');
    assert.equal(record.name, 'notes');
    assert.equal(record.registered, undefined);
    assert.equal(record.additionalJtis, undefined);
    const before = printed.calls.length;
    const revoked = run(['connect', 'alice/notes', '--revoke']);
    assert.equal(revoked.status, 0, revoked.stderr);
    assert.ok(revoked.calls.slice(before).some(call => call.startsWith('claude mcp remove notes')));
  } finally {
    cleanup();
  }
});

test('vibe connect <owner>/<slug> --revoke keeps the record and fails when the platform errs', () => {
  const { run, connections, cleanup } = setup();
  try {
    assert.equal(run(['connect', 'alice/notes', '--print'], { body: MINTED }).status, 0);
    for (const [delBody, delCode] of [['<html>Service Unavailable</html>', '503'], ['{"success":false,"error":"boom"}', '500']]) {
      const r = run(['connect', 'alice/notes', '--revoke'], { delBody, delCode });
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.stderr, /revoke failed — try again/);
      assert.doesNotMatch(r.stdout + r.stderr, /already stopped working|suspended/);
      assert.equal(connections()['alice--notes'].jti, '11111111-2222-4333-8444-555555555555');
    }
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
      expiresAt: '2026-12-30T00:00:00.000Z', url: 'https://alice--notes.vibe-coded.app/mcp',
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
