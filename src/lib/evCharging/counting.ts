// Dependency-free, client-safe. Sessions/intervals below this energy amount are
// noise (a car briefly handshaking without actually charging) and are excluded
// from totals/counts presented to users.
export const NOISE_THRESHOLD_KWH = 0.5
