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
