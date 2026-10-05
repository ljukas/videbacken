import { orpc } from '~/lib/orpc/client'

// Shared by both Energi pages: one cache entry per year, so switching between
// Översikt and Batteri costs no request (spec "Pages").
export const energyOverviewQuery = (year: number | undefined) =>
  orpc.energy.overview.queryOptions({ input: { year } })

export const emaldoHealthQuery = orpc.evCharging.syncStatus.queryOptions({
  input: { source: 'emaldo' },
})
