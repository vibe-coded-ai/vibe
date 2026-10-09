// `vibe publish` keeps waiting when the promotion is only slow.
// The platform answers 503 "Production promotion N is still in progress" once
// its ~25s wait runs out; the promotion then finishes on its own. Runs the
// real CLI with a stub curl that answers by URL (a sequence per URL) and a
// no-op sleep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const VIBE_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'vibe');

const PENDING = { success: false, error: 'Production promotion 2035 is still in progress. Production switches to this build when it finishes; check with vibe status.' };
const BUILDS = { success: true, builds: [{ id: 2034, status: 'succeeded', environment: 'preview' }] };
const build = (status, extra = {}) => ({ success: true, build: { id: 2035, environment: 'production', status, ...extra } });

// responses: [urlSubstring, [body, body, ...]] — each call to a URL takes the
// next body; the last one repeats. First matching substring wins.
function runPublish(responses) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-publish-'));
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
    responses.forEach(([match, bodies], i) => {
      writeFileSync(join(stubs, `${i}.match`), match);
      bodies.forEach((body, j) => writeFileSync(join(stubs, `${i}.${j}.body`), JSON.stringify(body)));
      writeFileSync(join(stubs, `${i}.last`), String(bodies.length - 1));
    });
    writeFileSync(join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(bin, 'curl'), [
      '#!/usr/bin/env bash',
      'cat >/dev/null',
      'url=""',
      'for a in "$@"; do case "$a" in https://*) url="$a";; esac; done',
      // The live-site check after publish: just the status code.
      'if [[ "$url" == *"alice--notes.vibe-coded.ai"* ]]; then printf 200; exit 0; fi',
      `for m in "${stubs}"/*.match; do`,
      '  if [[ "$url" == *"$(cat "$m")"* ]]; then',
      '    base="${m%.match}"; n=0; [ -f "$base.count" ] && n=$(cat "$base.count")',
      '    f="$base.$n.body"; [ -f "$f" ] || f="$base.$(cat "$base.last").body"',
      '    echo $((n + 1)) > "$base.count"',
      '    printf "%s\\n200" "$(cat "$f")"; exit 0',
      '  fi',
      'done',
      'printf "%s\\n404" \'{"success":false,"error":"not stubbed"}\'',
    ].join('\n'), { mode: 0o755 });
    return spawnSync('bash', [VIBE_BIN, 'publish'], {
      cwd: work,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, VIBE_NO_UPDATE_CHECK: '1' },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a slow promotion keeps waiting and ends in Published!', () => {
  const result = runPublish([
    ['/builds/2035', [build('building'), build('building'), build('building'), build('succeeded')]],
    ['/builds?limit=1', [BUILDS]],
    ['/publish', [PENDING]],
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /failed/i);
  assert.match(result.stdout, /Promotion 2035 is still running/);
  assert.match(result.stdout, /Published!/);
});

test('a promotion the platform reports failed says failed', () => {
  const result = runPublish([
    ['/builds/2035', [build('building'), build('failed', { errorMessage: 'Not deployed: bundle too large' })]],
    ['/builds?limit=1', [BUILDS]],
    ['/publish', [PENDING]],
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Publish failed: production promotion 2035 failed: Not deployed: bundle too large/);
  assert.doesNotMatch(result.stdout, /Published!/);
});

test('a promotion still running at the limit says still publishing, not failed', () => {
  const result = runPublish([
    ['/builds/2035', [build('building')]],
    ['/builds?limit=1', [BUILDS]],
    ['/publish', [PENDING]],
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Still publishing \(promotion 2035\).*run 'vibe status' in a minute/);
  assert.doesNotMatch(result.stderr, /failed/i);
});

test('any other publish error is still reported as failed', () => {
  const result = runPublish([
    ['/builds?limit=1', [BUILDS]],
    ['/publish', [{ success: false, error: 'No preview build to publish' }]],
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Publish failed: No preview build to publish/);
});
