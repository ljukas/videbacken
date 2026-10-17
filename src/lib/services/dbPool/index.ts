// The DB pool's gauges, for the `rpc timing` line (ADR-0025 §5). The pool lives
// in ~/lib/db, which only services may import (ADR-0002); this is that seam.
export { poolStats, watchPool } from '~/lib/db'
