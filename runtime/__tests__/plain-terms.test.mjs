import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const skillDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const docs = ['SKILL.md', ...readdirSync(join(skillDir, 'references')).filter(f => f.endsWith('.md')).map(f => join('references', f))];

// Provider and internal terms agents must not read in the skill's prose. The
// binding names authors type (env.VIBE_D1, env.VIBE_R2, env.VIBE_STORAGE) and
// fenced code blocks are exempt.
const FORBIDDEN = /\bD1\b|\bR2\b|\bKV\b|Cloudflare|\bunits\b/;

function prose(text) {
  return text.replace(/^```[\s\S]*?^```/gm, '').replace(/\benv\.VIBE_[A-Z0-9_]+/g, '');
}

for (const doc of docs) {
  test(`${doc} prose uses plain storage terms`, () => {
    const hits = prose(readFileSync(join(skillDir, doc), 'utf8')).split('\n')
      .map((line, i) => [i + 1, line]).filter(([, line]) => FORBIDDEN.test(line));
    assert.deepEqual(hits, []);
  });
}
