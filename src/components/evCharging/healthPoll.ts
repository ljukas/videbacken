// Sync health polls every minute; every 5 s while a run is in flight — seen by
// the server (`running` on any source, a cron run included) or started from
// this tab and not seen yet — so "Synkar…" and the progress bar follow the run
// and clear soon after it ends (a run's lease lasts at most 5 min). One poll
// covers every source: they're one read (ADR-0025 §5).
export const healthPoll =
  (pending: boolean) =>
  (query: { state: { data?: Partial<Record<string, { running: boolean }>> } }) =>
    pending || Object.values(query.state.data ?? {}).some((health) => health?.running)
      ? 5_000
      : 60_000
