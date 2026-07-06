import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getModelScopedUsage, SCOPED_USAGE_TTL_MS } from '../dist/scoped-usage.js';

function restoreEnvVar(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function makeHome({ withCredentials = true } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'hud-scoped-'));
  if (withCredentials) {
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(
      path.join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'test-token' } }),
      'utf8',
    );
  }
  return home;
}

function cachePath(home) {
  return path.join(home, '.claude', 'plugins', 'claude-hud', 'scoped-usage-cache.json');
}

const USAGE_BODY = {
  limits: [
    { kind: 'session', group: 'session', percent: 38, resets_at: '2026-07-07T01:30:00+00:00', scope: null },
    { kind: 'weekly_all', group: 'weekly', percent: 8, resets_at: '2026-07-07T09:00:00+00:00', scope: null },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 15.4,
      resets_at: '2026-07-07T09:00:00+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
    },
    // Malformed scoped entries must be dropped, never break parsing.
    { kind: 'weekly_scoped', percent: 5, resets_at: null, scope: { model: { display_name: '   ' } } },
    { kind: 'weekly_scoped', percent: 5, resets_at: null, scope: null },
  ],
};

async function withCleanConfigDirEnv(run) {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    return await run();
  } finally {
    restoreEnvVar('CLAUDE_CONFIG_DIR', saved);
  }
}

test('getModelScopedUsage fetches, parses weekly_scoped limits, and writes the cache', async () => {
  await withCleanConfigDirEnv(async () => {
    const home = await makeHome();
    try {
      let calls = 0;
      const fetchImpl = async (url, init) => {
        calls += 1;
        assert.ok(String(url).endsWith('/api/oauth/usage'));
        assert.equal(init.headers.Authorization, 'Bearer test-token');
        assert.equal(init.headers['anthropic-beta'], 'oauth-2025-04-20');
        return { ok: true, json: async () => USAGE_BODY };
      };

      const scoped = await getModelScopedUsage({ homeDir: home, fetchImpl, now: () => 1_000_000 });

      assert.deepEqual(scoped, [
        { label: 'Fable', percent: 15, resetAt: new Date('2026-07-07T09:00:00+00:00') },
      ]);
      assert.equal(calls, 1);

      const cache = JSON.parse(await readFile(cachePath(home), 'utf8'));
      assert.equal(cache.checked_at, 1_000_000);
      assert.deepEqual(cache.scoped, [
        { label: 'Fable', percent: 15, resets_at: '2026-07-07T09:00:00+00:00' },
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

test('getModelScopedUsage serves a fresh cache without calling fetch', async () => {
  await withCleanConfigDirEnv(async () => {
    const home = await makeHome();
    try {
      const fetchOnce = async () => ({ ok: true, json: async () => USAGE_BODY });
      await getModelScopedUsage({ homeDir: home, fetchImpl: fetchOnce, now: () => 1_000_000 });

      const scoped = await getModelScopedUsage({
        homeDir: home,
        fetchImpl: async () => {
          throw new Error('fetch must not be called while the cache is fresh');
        },
        now: () => 1_000_000 + SCOPED_USAGE_TTL_MS - 1,
      });

      assert.deepEqual(scoped, [
        { label: 'Fable', percent: 15, resetAt: new Date('2026-07-07T09:00:00+00:00') },
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

test('getModelScopedUsage returns null without credentials and never fetches', async () => {
  await withCleanConfigDirEnv(async () => {
    const home = await makeHome({ withCredentials: false });
    try {
      let calls = 0;
      const scoped = await getModelScopedUsage({
        homeDir: home,
        fetchImpl: async () => {
          calls += 1;
          return { ok: true, json: async () => USAGE_BODY };
        },
        now: () => 1_000_000,
      });

      assert.equal(scoped, null);
      assert.equal(calls, 0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

test('getModelScopedUsage throttles failed fetches through the cache', async () => {
  await withCleanConfigDirEnv(async () => {
    const home = await makeHome();
    try {
      const failing = async () => {
        throw new Error('network down');
      };

      const first = await getModelScopedUsage({ homeDir: home, fetchImpl: failing, now: () => 1_000_000 });
      assert.equal(first, null);

      // The failed attempt is recorded, so retries stay inside the TTL window.
      let calls = 0;
      const second = await getModelScopedUsage({
        homeDir: home,
        fetchImpl: async () => {
          calls += 1;
          return { ok: true, json: async () => USAGE_BODY };
        },
        now: () => 1_000_000 + SCOPED_USAGE_TTL_MS - 1,
      });

      assert.deepEqual(second, []);
      assert.equal(calls, 0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
