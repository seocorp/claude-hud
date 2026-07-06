/** Check if usage limit is reached (either window at 100%) */
export function isLimitReached(data) {
    return data.fiveHour === 100 || data.sevenDay === 100;
}
// Fable 5 is included for up to 50% of the weekly usage limit, but Claude
// Code doesn't forward a Fable-scoped window in the statusline payload
// (only /usage shows one). Treat 50% of the weekly window as 100% of the
// Fable allowance and derive the gauge from the live weekly value.
export const FABLE_LABEL = 'Fable';
export const FABLE_WEEKLY_SHARE = 0.5;
export function deriveFableUsage(data) {
    if (data.sevenDay == null) {
        return null;
    }
    return {
        label: FABLE_LABEL,
        percent: Math.min(100, Math.round(data.sevenDay / FABLE_WEEKLY_SHARE)),
        resetAt: data.sevenDayResetAt,
    };
}
//# sourceMappingURL=types.js.map