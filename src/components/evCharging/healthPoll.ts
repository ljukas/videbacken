// Sync health polls every minute; every 5 s while a run is in flight — seen by
// the server (`running`, a cron run included) or started from this tab and not
// seen yet — so "Synkar…" and the progress bar follow the run and clear soon
// after it ends (a run's lease lasts at most 5 min).
export const healthPoll =
  (pending: boolean) => (query: { state: { data?: { running: boolean } } }) =>
    pending || query.state.data?.running ? 5_000 : 60_000
