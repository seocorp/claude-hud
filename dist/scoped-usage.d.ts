import type { ModelScopedUsage } from './types.js';
export declare const SCOPED_USAGE_TTL_MS = 60000;
type ScopedUsageDeps = {
    fetchImpl: typeof fetch;
    homeDir: string;
    now: () => number;
};
/**
 * Per-model weekly usage windows (e.g. "Fable"), fetched from the OAuth
 * usage API with an on-disk TTL cache shared across sessions. Returns null
 * when nothing is known (no cache and no credentials, or first fetch failed).
 * Never throws: statusline rendering must survive any failure here.
 */
export declare function getModelScopedUsage(overrides?: Partial<ScopedUsageDeps>): Promise<ModelScopedUsage[] | null>;
export {};
//# sourceMappingURL=scoped-usage.d.ts.map