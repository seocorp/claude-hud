import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getClaudeConfigDir, getHudPluginDir } from './claude-config-dir.js';
import { createDebug } from './debug.js';
import { sanitizeDisplayText } from './utils/sanitize.js';
const debug = createDebug('scoped-usage');
// Claude Code does not (yet) forward per-model weekly windows in the
// statusline payload, even though its /usage screen shows them (e.g.
// "Current week (Fable)"). This module fetches the same server data those
// rows are built from — the limits[] array of the OAuth usage endpoint —
// and caches it so the ~300ms statusline loop performs at most one
// request per TTL. When Claude Code starts sending rate_limits.model_scoped
// on stdin, that takes precedence and this fallback is never invoked.
const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
export const SCOPED_USAGE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 3_000;
const MAX_LABEL_LENGTH = 30;
const CACHE_FILE_NAME = 'scoped-usage-cache.json';
function parsePercent(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return null;
    }
    return Math.round(Math.min(100, Math.max(0, value)));
}
function parseResetIso(value) {
    if (typeof value !== 'string' || !value.trim()) {
        return null;
    }
    return Number.isNaN(new Date(value).getTime()) ? null : value;
}
function readAccessToken(configDir) {
    try {
        const raw = fs.readFileSync(path.join(configDir, '.credentials.json'), 'utf8');
        const token = JSON.parse(raw)
            .claudeAiOauth?.accessToken;
        return typeof token === 'string' && token.trim() ? token : null;
    }
    catch (err) {
        debug('No usable credentials:', err instanceof Error ? err.message : err);
        return null;
    }
}
/** Extract weekly per-model windows from the usage endpoint's limits[] array. */
function parseScopedLimits(body) {
    const limits = body?.limits;
    if (!Array.isArray(limits)) {
        return [];
    }
    const scoped = [];
    for (const entry of limits) {
        if (!entry || typeof entry !== 'object') {
            continue;
        }
        const limit = entry;
        if (limit.kind !== 'weekly_scoped') {
            continue;
        }
        const displayName = limit.scope?.model?.display_name;
        if (typeof displayName !== 'string') {
            continue;
        }
        const label = sanitizeDisplayText(displayName).trim().slice(0, MAX_LABEL_LENGTH);
        if (!label) {
            continue;
        }
        scoped.push({
            label,
            percent: parsePercent(limit.percent),
            resets_at: parseResetIso(limit.resets_at),
        });
    }
    return scoped;
}
function reviveScoped(entries) {
    return entries.map((entry) => ({
        label: entry.label,
        percent: entry.percent,
        resetAt: entry.resets_at ? new Date(entry.resets_at) : null,
    }));
}
function readCache(cachePath) {
    try {
        const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        if (typeof parsed?.checked_at !== 'number' || !Array.isArray(parsed.scoped)) {
            return null;
        }
        return {
            checked_at: parsed.checked_at,
            scoped: parsed.scoped.filter((entry) => !!entry && typeof entry.label === 'string' && entry.label.length > 0),
        };
    }
    catch {
        return null;
    }
}
function writeCache(cachePath, cache) {
    const tmpPath = `${cachePath}.${process.pid}.tmp`;
    try {
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(tmpPath, `${JSON.stringify(cache)}\n`, { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tmpPath, cachePath);
    }
    catch (err) {
        debug('Failed to write cache:', err instanceof Error ? err.message : err);
        try {
            fs.rmSync(tmpPath, { force: true });
        }
        catch {
            // best effort cleanup only
        }
    }
}
/**
 * Per-model weekly usage windows (e.g. "Fable"), fetched from the OAuth
 * usage API with an on-disk TTL cache shared across sessions. Returns null
 * when nothing is known (no cache and no credentials, or first fetch failed).
 * Never throws: statusline rendering must survive any failure here.
 */
export async function getModelScopedUsage(overrides = {}) {
    const deps = {
        fetchImpl: fetch,
        homeDir: os.homedir(),
        now: () => Date.now(),
        ...overrides,
    };
    const configDir = getClaudeConfigDir(deps.homeDir);
    const cachePath = path.join(getHudPluginDir(deps.homeDir), CACHE_FILE_NAME);
    const now = deps.now();
    const cached = readCache(cachePath);
    if (cached && now - cached.checked_at < SCOPED_USAGE_TTL_MS) {
        return reviveScoped(cached.scoped);
    }
    const token = readAccessToken(configDir);
    if (!token) {
        return cached ? reviveScoped(cached.scoped) : null;
    }
    // Claim the refresh slot before fetching. The usage endpoint rate-limits
    // aggressively (back-to-back requests get 429), and the statusline runs as
    // many concurrent short-lived processes, so without a claim a cold cache
    // triggers a stampede. The claim keeps the last known data and throttles
    // every outcome — success or failure — to one attempt per TTL.
    writeCache(cachePath, { checked_at: now, scoped: cached?.scoped ?? [] });
    try {
        const response = await deps.fetchImpl(USAGE_ENDPOINT, {
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                'anthropic-beta': OAUTH_BETA_HEADER,
            },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const scoped = parseScopedLimits(await response.json());
        writeCache(cachePath, { checked_at: now, scoped });
        return reviveScoped(scoped);
    }
    catch (err) {
        debug('Usage fetch failed:', err instanceof Error ? err.message : err);
        // Leave the claim as-is: never overwrite data a concurrent successful
        // refresh may have just written, and keep serving what we knew.
        return cached ? reviveScoped(cached.scoped) : null;
    }
}
//# sourceMappingURL=scoped-usage.js.map