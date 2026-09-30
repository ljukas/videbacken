// Dependency-free, client-safe. Sessions/intervals below this energy amount are
// noise (a car briefly handshaking without actually charging) and are excluded
// from totals/counts presented to users.
export const NOISE_THRESHOLD_KWH = 0.5

// The years the overview can show. The `overview` procedure only accepts these,
// so the year list the service returns is clamped to them too — a session with
// a broken clock (1970) or one just before 2020 in Stockholm time must never
// offer a year the procedure then rejects.
export const OVERVIEW_MIN_YEAR = 2020
export const OVERVIEW_MAX_YEAR = 2100

// Intervals shorter than this are Zaptec sampling noise, not a sustained rate —
// excluded from a session's peak kW (the session list and the timeline agree).
export const PEAK_MIN_INTERVAL_MS = 600_000
// An interval delivering less than this is plugged-in-but-idle, not charging.
export const IDLE_INTERVAL_KWH = 0.05
