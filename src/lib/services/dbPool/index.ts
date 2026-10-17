// The DB pool's gauges, for the `rpc timing` line (ADR-0025 §5), and its
// first-request warm-up (server-latency row 8). The pool lives in ~/lib/db,
// which only services may import (ADR-0002); this is that seam.
export { poolStats, warmUpPool, watchPool } from '~/lib/db'
