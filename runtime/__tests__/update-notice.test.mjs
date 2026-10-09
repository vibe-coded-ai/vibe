import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VIBE_BIN = join(SKILL_DIR, 'bin', 'vibe');
const CURRENT = JSON.parse(readFileSync(join(SKILL_DIR, 'package.json'), 'utf8')).version;

function bump(version, part) {
  const v = version.split('.').map(Number);
  v[part] += 1;
  for (let i = part + 1; i < 3; i++) v[i] = 0;
  return v.join('.');
}

// Runs `vibe templates` (no network, no credentials) with a stub curl that
// serves `published` for skill-version.txt and counts its calls.
function run({ published, cached, cacheAgeDays = 0, env = {}, cmd = 'templates', installed }) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-update-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(join(home, '.vibe-coded'), { recursive: true });
  mkdirSync(bin);
  const log = join(root, 'curl.log');
  writeFileSync(join(bin, 'curl'), [
    '#!/usr/bin/env bash',
    'echo "$*" >> "$STUB_LOG"',
    'if [ -z "$STUB_PUBLISHED" ]; then exit 22; fi',
    'printf "%s\\n" "$STUB_PUBLISHED"',
  ].join('\n'), { mode: 0o755 });
  const cache = join(home, '.vibe-coded', 'latest-version');
  if (cached !== undefined) {
    writeFileSync(cache, cached);
    const t = Date.now() / 1000 - cacheAgeDays * 86400;
    utimesSync(cache, t, t);
  }
  // `installed` stages a copy of the CLI whose package.json reports that version.
  let bin_ = VIBE_BIN;
  if (installed) {
    const skill = join(root, 'skill');
    mkdirSync(join(skill, 'bin'), { recursive: true });
    copyFileSync(VIBE_BIN, join(skill, 'bin', 'vibe'));
    writeFileSync(join(skill, 'package.json'), JSON.stringify({ version: installed }));
    bin_ = join(skill, 'bin', 'vibe');
  }
  const result = spawnSync('bash', [bin_, cmd], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, STUB_LOG: log, STUB_PUBLISHED: published ?? '', ...env },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  const cacheAfter = existsSync(cache) ? readFileSync(cache, 'utf8') : null;
  rmSync(root, { recursive: true, force: true });
  return { ...result, calls, cacheAfter };
}

test('prints one stderr line when a newer version is published, and caches it', () => {
  const newer = bump(CURRENT, 1);
  const r = run({ published: newer });
  assert.equal(r.status, 0);
  assert.match(r.stderr, new RegExp(`vibe ${newer.replaceAll('.', '\\.')} is available \\(you have ${CURRENT.replaceAll('.', '\\.')}\\)`));
  assert.match(r.stderr, /curl -fsSL https:\/\/vibe-coded\.ai\/install\.sh \| sh/);
  assert.doesNotMatch(r.stdout, /is available/);
  assert.equal(r.calls.length, 1);
  assert.match(r.calls[0], /--max-time 2 .*skill-version\.txt/);
  assert.equal(r.cacheAfter, newer);
});

test('silent when current or older; numeric compare (4.10.0 > 4.9.0)', () => {
  assert.doesNotMatch(run({ published: CURRENT }).stderr, /is available/);
  assert.doesNotMatch(run({ published: '0.0.1' }).stderr, /is available/);
  // Fixed operands where string order disagrees with numeric order.
  assert.match(run({ installed: '4.9.0', published: '4.10.0' }).stderr, /vibe 4\.10\.0 is available \(you have 4\.9\.0\)/);
  assert.doesNotMatch(run({ installed: '4.10.0', published: '4.9.0' }).stderr, /is available/);
});

test('uses a fresh cache without a request; refreshes a day-old one', () => {
  const newer = bump(CURRENT, 2);
  const fresh = run({ published: '', cached: newer, cacheAgeDays: 0 });
  assert.equal(fresh.calls.length, 0);
  assert.match(fresh.stderr, /is available/);
  const stale = run({ published: CURRENT, cached: newer, cacheAgeDays: 2 });
  assert.equal(stale.calls.length, 1);
  assert.doesNotMatch(stale.stderr, /is available/);
  assert.equal(stale.cacheAfter, CURRENT);
});

test('network failure or junk is silent and never fails the command', () => {
  for (const published of ['', '<html>not found</html>', '9.9.9; rm -rf /']) {
    const r = run({ published });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
  }
});

test('VIBE_NO_UPDATE_CHECK disables the check; --version and help never check', () => {
  assert.equal(run({ published: bump(CURRENT, 0), env: { VIBE_NO_UPDATE_CHECK: '1' } }).calls.length, 0);
  for (const cmd of ['--version', 'help']) {
    assert.equal(run({ published: bump(CURRENT, 0), cmd }).calls.length, 0, cmd);
  }
});

test('installer only suggests login when signed out and PATH edits when needed', () => {
  // install.sh sits at the skill root in the public repo and under vibes/www/public in the monorepo.
  const installer = [
    join(SKILL_DIR, 'install.sh'),
    join(SKILL_DIR, '..', '..', 'vibes', 'www', 'public', 'install.sh'),
  ].find(existsSync);
  assert.ok(installer, 'install.sh not found next to the skill or in the monorepo');
  for (const signedIn of [false, true, 'expired', 'malformed']) {
    for (const onPath of [false, true]) {
      const root = mkdtempSync(join(tmpdir(), 'vibe-installer-'));
      try {
        const home = join(root, 'home');
        const stubBin = join(root, 'stubs');
        const binDir = join(home, '.local', 'bin');
        const skill = join(root, 'archive', 'vibe-coded-ai');
        mkdirSync(join(home, '.vibe-coded'), { recursive: true });
        mkdirSync(stubBin);
        mkdirSync(join(skill, 'bin'), { recursive: true });
        writeFileSync(join(skill, 'SKILL.md'), 'synthetic installer fixture');
        writeFileSync(join(skill, 'bin', 'vibe'), '#!/bin/sh\nexit 0\n');
        if (signedIn === 'malformed') writeFileSync(join(home, '.vibe-coded', 'credentials.json'), 'not-json {"token":"x","expiresAt":"2099-01-01T00:00:00Z"}');
        else if (signedIn) writeFileSync(join(home, '.vibe-coded', 'credentials.json'), JSON.stringify({
          token: 'cli-token', userSlug: 'tester',
          expiresAt: signedIn === 'expired' ? '2001-01-01T00:00:00Z' : '2099-01-01T00:00:00Z',
        }));
        writeFileSync(join(stubBin, 'curl'), [
          '#!/bin/sh',
          '[ "$2" = https://vibe-coded.ai/vibe-coded-ai-skill.zip ] || exit 1',
          '[ "$3" = -o ] || exit 1',
          ': > "$4"',
        ].join('\n'), { mode: 0o755 });
        writeFileSync(join(stubBin, 'unzip'), [
          '#!/bin/sh',
          '[ "$3" = -d ] || exit 1',
          'mkdir -p "$4"',
          'cp -R "$STUB_SKILL_DIR" "$4/vibe-coded-ai"',
        ].join('\n'), { mode: 0o755 });
        const result = spawnSync('sh', [installer], {
          encoding: 'utf8', timeout: 10000,
          env: {
            ...process.env, HOME: home, SHELL: '/bin/zsh',
            PATH: `${onPath ? binDir : `${binDir}-other`}:${stubBin}:${process.env.PATH}`,
            CLAUDE_SKILLS_DIR: join(home, '.claude', 'skills'),
            VIBE_BIN_DIR: binDir,
            VIBE_AGENTS_SKILLS_DIR: join(home, '.agents', 'skills'),
            VIBE_BACKUP_DIR: join(home, '.vibe-coded', 'skill-backups'),
            STUB_SKILL_DIR: skill,
          },
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readlinkSync(join(binDir, 'vibe')), join(home, '.claude', 'skills', 'vibe-coded-ai', 'bin', 'vibe'));
        if (signedIn === true) assert.doesNotMatch(result.stdout, /Next:.*login|without changing PATH:.*login/);
        else assert.match(result.stdout, /Next:\s+vibe login/);
        if (onPath) assert.doesNotMatch(result.stdout, /not on your PATH|\.zshrc|export PATH/);
        else assert.match(result.stdout, /not on your PATH[\s\S]*\.zshrc/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
});

test('the patch version is bumped together in package.json and skill frontmatter', () => {
  assert.equal(CURRENT, '4.5.6');
  assert.match(readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8'), /^version: 4\.5\.6$/m);
});
