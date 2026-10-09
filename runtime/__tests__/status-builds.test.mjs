// `vibe status` names the production build the same way its recent-builds
// list does: publish records its own production build row that
// promotes a preview build, and the production pointer holds the preview id.
// Runs the real CLI with a stub curl that answers by URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const VIBE_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'vibe');

function runStatus(responses, args = ['status']) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-status-'));
  try {
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    const work = join(root, 'work');
    const stubs = join(root, 'stubs');
    mkdirSync(join(home, '.vibe-coded'), { recursive: true });
    mkdirSync(bin);
    mkdirSync(work);
    mkdirSync(stubs);
    writeFileSync(join(home, '.vibe-coded', 'credentials.json'), JSON.stringify({
      token: 'cli-login-token',
      userSlug: 'alice',
      apiUrl: 'https://api.vibe-coded.ai',
      expiresAt: '2099-01-01T00:00:00Z',
    }));
    writeFileSync(join(work, '.vibe-coded.json'), JSON.stringify({ vibeSlug: 'notes' }));
    // Each response is keyed by a substring of the request URL; first match wins.
    responses.forEach(([match, body], i) => {
      writeFileSync(join(stubs, `${i}.match`), match);
      writeFileSync(join(stubs, `${i}.body`), JSON.stringify(body));
    });
    writeFileSync(join(bin, 'curl'), [
      '#!/usr/bin/env bash',
      'cat >/dev/null',
      'url=""',
      'for a in "$@"; do case "$a" in https://*) url="$a";; esac; done',
      `for m in "${stubs}"/*.match; do`,
      '  if [[ "$url" == *"$(cat "$m")"* ]]; then printf "%s\\n200" "$(cat "${m%.match}.body")"; exit 0; fi',
      'done',
      'printf "%s\\n404" \'{"success":false,"error":"not stubbed"}\'',
    ].join('\n'), { mode: 0o755 });
    return spawnSync('bash', [VIBE_BIN, ...args], {
      cwd: work,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, VIBE_NO_UPDATE_CHECK: '1' },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const VIBE = { success: true, vibe: { title: 'Notes', visibility: 'private', previewBuildId: 1916, productionBuildId: 1914 } };
const RECENT = {
  success: true,
  builds: [
    { id: 1917, status: 'succeeded', environment: 'production', sourceHash: 'h1914', createdAt: '2026-10-01T10:03:00Z' },
    { id: 1916, status: 'succeeded', environment: 'preview', sourceHash: 'h1916', createdAt: '2026-10-01T10:02:00Z' },
    { id: 1914, status: 'succeeded', environment: 'preview', sourceHash: 'h1914', createdAt: '2026-10-01T10:00:00Z' },
  ],
};

test('vibe status names the production build row and the preview build it promoted', () => {
  const result = runStatus([
    ['/builds/1914', { success: true, build: { id: 1914, environment: 'preview', status: 'succeeded', sourceHash: 'h1914' } }],
    ['environment=production', { success: true, builds: [
      { id: 1917, status: 'succeeded', environment: 'production', sourceHash: 'h1914' },
      { id: 1915, status: 'succeeded', environment: 'production', sourceHash: 'h1900' },
    ] }],
    ['/builds?limit=5', RECENT],
    ['/api/v1/vibes/alice/notes', VIBE],
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Production: build 1917 \(promoted from preview build 1914\)/);
  assert.match(result.stdout, /Preview:    build 1916/);
});

test('vibe status does not pair a production row built from different source', () => {
  const result = runStatus([
    ['/builds/1914', { success: true, build: { id: 1914, environment: 'preview', status: 'succeeded', sourceHash: 'h1914' } }],
    ['environment=production', { success: true, builds: [
      { id: 1918, status: 'failed', environment: 'production', sourceHash: 'h1914' },
      { id: 1915, status: 'succeeded', environment: 'production', sourceHash: 'h1900' },
    ] }],
    ['/builds?limit=5', RECENT],
    ['/api/v1/vibes/alice/notes', VIBE],
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Production: preview build 1914\n/);
});

test('vibe status keeps the plain label when the pointer is itself a production build', () => {
  const result = runStatus([
    ['/builds?limit=5', { success: true, builds: [
      { id: 1800, status: 'succeeded', environment: 'production', sourceHash: 'h', createdAt: '2026-01-01T00:00:00Z' },
    ] }],
    ['/api/v1/vibes/alice/notes', { success: true, vibe: { productionBuildId: 1800 } }],
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Production: build 1800\n/);
});

// `vibe status --plan` keeps the bare tier on line 1 and adds the upgrade
// path, so an agent can answer "how do I upgrade" from the CLI.
for (const [plan, upgrade] of [
  ['free', /^Upgrade: Pro \(\$9\/mo\) or Pro\+ \(\$20\/mo\) at https:\/\/vibe-coded\.ai\/billing$/m],
  ['byov', /^Upgrade: Pro\+ \(\$20\/mo\) at https:\/\/vibe-coded\.ai\/billing$/m],
  ['pro', /^Pro\+ is the highest plan\. Billing: https:\/\/vibe-coded\.ai\/billing$/m],
]) {
  test(`vibe status --plan on ${plan} prints the tier, then where to upgrade`, () => {
    const result = runStatus([['/api/v1/vibes', { success: true, plan, vibes: [] }]], ['status', '--plan']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.split('\n')[0], plan);
    assert.match(result.stdout, upgrade);
    assert.match(result.stdout, /^Plans and limits: https:\/\/vibe-coded\.ai\/pricing$/m);
  });
}
