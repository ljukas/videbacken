// Sync health polls every minute; every 5 s while a run is in flight — seen by
// the server (`running`, a cron run included) or started from this tab and not
// seen yet — so "Synkar…" and the progress bar follow the run and clear soon
// after it ends (a run's lease lasts at most 5 min). One poll covers every
// source: they're one read (ADR-0025 §5). `sources` limits the `running` check
// to the sources a page shows, so a run it can't show doesn't speed its poll.
export const healthPoll =
  (pending: boolean, sources?: readonly string[]) =>
  (query: { state: { data?: Partial<Record<string, { running: boolean }>> } }) => {
    const data = query.state.data ?? {}
    const shown = sources ? sources.map((source) => data[source]) : Object.values(data)
    return pending || shown.some((health) => health?.running) ? 5_000 : 60_000
  }
