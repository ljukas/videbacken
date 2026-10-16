import { QueryClientProvider } from '@tanstack/react-query'
import { renderToString } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { HeatPumpEventDto } from '~/lib/heatPump/events'
import { m } from '~/paraglide/messages'
import { makeTestQueryClient, renderWithProviders } from '~test/browser/render'
import { signatureRow, signatureUnitDays } from '~test/fixtures/heatPumpSignature'
import { EnergySignatureSection } from './EnergySignatureSection'
import { eventKindLabel } from './eventCopy'
import { heatPumpDaysQuery, heatPumpEventsQuery, heatPumpMonthsQueryFor } from './heatPumpQueries'

const MATSAL = 'hp-matsal'
const OVER = 'hp-overvaning'
const TODAY = '2026-02-10'
const service: HeatPumpEventDto = {
  id: 'svc',
  occurredOn: '2026-01-20',
  heatPumpId: null,
  kind: 'service',
  note: null,
}
// Units deliberately out of name order: the section sorts with byHeatPumpName.
const months = (firstReadingDay = '2024-10-31') =>
  ({
    units: [
      { id: OVER, name: 'Övervåning' },
      { id: MATSAL, name: 'Matsal' },
    ],
    firstReadingDay,
  }) as never
const readout = () => document.querySelector('[data-slot="signature-readout"]') as HTMLElement

const seeded = (events: HeatPumpEventDto[]) => {
  const qc = makeTestQueryClient()
  qc.setQueryData(heatPumpMonthsQueryFor(null).queryKey, months())
  qc.setQueryData(heatPumpEventsQuery.queryKey, events as never)
  // 2026-01-20 − 400 days = 2024-12-16 (after the first reading) … today: one chunk.
  qc.setQueryData(heatPumpDaysQuery({ from: '2024-12-16', to: TODAY }).queryKey, {
    units: [],
    days: [...signatureUnitDays(MATSAL, 0.9), ...signatureUnitDays(OVER, 1.1)],
  } as never)
  return qc
}

test('Matsal first, its default event, the signature computed from the event’s range', async () => {
  const qc = seeded([service])
  const { screen } = await renderWithProviders(<EnergySignatureSection today={TODAY} />, {
    queryClient: qc,
  })
  await vi.waitFor(() => expect(readout().dataset.state).toBe('ok'))
  await expect
    .element(screen.getByRole('radio', { name: 'Matsal' }))
    .toHaveAttribute('aria-checked', 'true')
  expect(Number(readout().dataset.change)).toBeCloseTo(-0.1, 10)
})

test('an event only Matsal has falls back to Övervåning’s default when switching unit', async () => {
  const filter: HeatPumpEventDto = {
    id: 'flt',
    occurredOn: '2026-01-20',
    heatPumpId: MATSAL,
    kind: 'filter',
    note: null,
  }
  const qc = seeded([service, filter])
  const { screen } = await renderWithProviders(<EnergySignatureSection today={TODAY} />, {
    queryClient: qc,
  })
  await vi.waitFor(() => expect(readout().dataset.state).toBe('ok'))
  await userEvent.click(screen.getByRole('combobox', { name: m.heat_pump_signature_event_label() }))
  await userEvent.click(screen.getByRole('option', { name: new RegExp(eventKindLabel('filter')) }))
  await vi.waitFor(() =>
    expect(readout().textContent).toContain(m.heat_pump_signature_after_filter()),
  )
  await userEvent.click(screen.getByRole('radio', { name: 'Övervåning' }))
  await vi.waitFor(() =>
    expect(readout().textContent).toContain(m.heat_pump_signature_after_service()),
  )
  expect(Number(readout().dataset.change)).toBeCloseTo(0.1, 10)
})

test('switching unit resets to that unit’s default, even when the chosen Båda event applies to both', async () => {
  // A Båda event older than the service: it applies to Övervåning too, so only the reset can drop it.
  const older: HeatPumpEventDto = {
    id: 'old',
    occurredOn: '2025-12-01',
    heatPumpId: null,
    kind: 'other',
    note: null,
  }
  const qc = seeded([older, service])
  // 2025-12-01 − 400 days = 2024-10-27, clipped to the first reading 2024-10-31; up to the next event, 2026-01-20.
  qc.setQueryData(heatPumpDaysQuery({ from: '2024-10-31', to: '2026-01-20' }).queryKey, {
    units: [],
    days: [],
  } as never)
  const { screen } = await renderWithProviders(<EnergySignatureSection today={TODAY} />, {
    queryClient: qc,
  })
  await vi.waitFor(() => expect(readout().dataset.state).toBe('ok'))
  const trigger = screen.getByRole('combobox', { name: m.heat_pump_signature_event_label() })
  await userEvent.click(trigger)
  await userEvent.click(screen.getByRole('option', { name: new RegExp(eventKindLabel('other')) }))
  await vi.waitFor(() => expect(trigger.element().textContent).toContain(eventKindLabel('other')))
  await userEvent.click(screen.getByRole('radio', { name: 'Övervåning' }))
  await vi.waitFor(() => expect(trigger.element().textContent).toContain(eventKindLabel('service')))
  await vi.waitFor(() =>
    expect(readout().textContent).toContain(m.heat_pump_signature_after_service()),
  )
})

test('a range over 800 days arrives in two chunks and the signature sees both', async () => {
  // A service on 2024-01-10, today 2026-06-01: 2022-12-06 … 2026-06-01 = 1 274 days,
  // fetched as 2022-12-06 … 2025-02-12 and 2025-02-13 … 2026-06-01.
  const old: HeatPumpEventDto = {
    id: 'old',
    occurredOn: '2024-01-10',
    heatPumpId: null,
    kind: 'service',
    note: null,
  }
  const qc = makeTestQueryClient()
  qc.setQueryData(heatPumpMonthsQueryFor(null).queryKey, months('2022-10-01'))
  qc.setQueryData(heatPumpEventsQuery.queryKey, [old] as never)
  // The before-days (2023-12-25 … 2024-01-09) in the first chunk; the after-days moved into the second.
  const all = signatureUnitDays(MATSAL, 0.9, '2023-12-25')
  const after = all
    .slice(16)
    .map((d, i) => ({ ...d, day: `2025-03-${String(i + 1).padStart(2, '0')}` }))
  qc.setQueryData(heatPumpDaysQuery({ from: '2022-12-06', to: '2025-02-12' }).queryKey, {
    units: [],
    days: all.slice(0, 16),
  } as never)
  qc.setQueryData(heatPumpDaysQuery({ from: '2025-02-13', to: '2026-06-01' }).queryKey, {
    units: [],
    days: after,
  } as never)
  await renderWithProviders(<EnergySignatureSection today="2026-06-01" />, { queryClient: qc })
  await vi.waitFor(() => expect(readout().dataset.state).toBe('ok'))
  expect(Number(readout().dataset.change)).toBeCloseTo(-0.1, 10)
})

test('while the days load, the card shows its loading state', async () => {
  const qc = makeTestQueryClient()
  qc.setQueryData(heatPumpMonthsQueryFor(null).queryKey, months())
  qc.setQueryData(heatPumpEventsQuery.queryKey, [service] as never)
  void qc.prefetchQuery({
    queryKey: heatPumpDaysQuery({ from: '2024-12-16', to: TODAY }).queryKey,
    queryFn: () => new Promise(() => {}),
  })
  await renderWithProviders(<EnergySignatureSection today={TODAY} />, { queryClient: qc })
  await vi.waitFor(() => expect(readout().dataset.state).toBe('loading'))
})

test('while the events load, the section shows its skeleton and no card', async () => {
  const qc = makeTestQueryClient()
  qc.setQueryData(heatPumpMonthsQueryFor(null).queryKey, months())
  void qc.prefetchQuery({
    queryKey: heatPumpEventsQuery.queryKey,
    queryFn: () => new Promise(() => {}),
  })
  await renderWithProviders(<EnergySignatureSection today={TODAY} />, { queryClient: qc })
  // Before the capture (Step 6) the section has a name only: boneyard's wrapper or the plain fallback block.
  await vi.waitFor(() =>
    expect(
      document.querySelector(
        '[data-boneyard="heat-pumps-signature"], [data-section-skeleton-fallback]',
      ),
    ).not.toBeNull(),
  )
  expect(readout()).toBeNull()
})

test('server render while the deferred events load: no card, so no false “no event yet”', async () => {
  // The loader awaits the months on the server and defers the events: the server renders without them.
  // SectionSkeleton shows its skeleton only once hydrated, so the section itself must render nothing.
  const qc = makeTestQueryClient()
  qc.setQueryData(heatPumpMonthsQueryFor(null).queryKey, months())
  void qc.prefetchQuery({
    queryKey: heatPumpEventsQuery.queryKey,
    queryFn: () => new Promise(() => {}),
  })
  const html = renderToString(
    <QueryClientProvider client={qc}>
      <EnergySignatureSection today={TODAY} />
    </QueryClientProvider>,
  )
  expect(html).not.toContain('signature-readout')
  expect(html).not.toContain(m.heat_pump_signature_no_event({ unit: 'Matsal' }))
})

test('an event whose whole range lies before the first reading reads 0 days, not loading forever', async () => {
  // The 2024 service (the default: the latest service) is followed by a filter cleaning in 2025, and the first
  // reading is after both: from 2025-11-01 > to 2025-10-03, no days to fetch.
  const old: HeatPumpEventDto = {
    id: 'old',
    occurredOn: '2024-10-05',
    heatPumpId: null,
    kind: 'service',
    note: null,
  }
  const filter: HeatPumpEventDto = {
    id: 'flt',
    occurredOn: '2025-10-03',
    heatPumpId: null,
    kind: 'filter',
    note: null,
  }
  const qc = makeTestQueryClient()
  qc.setQueryData(heatPumpMonthsQueryFor(null).queryKey, months('2025-11-01'))
  qc.setQueryData(heatPumpEventsQuery.queryKey, [filter, old] as never)
  await renderWithProviders(<EnergySignatureSection today={TODAY} />, { queryClient: qc })
  await vi.waitFor(() => expect(readout().dataset.state).toBe('not_enough_before'))
  expect(readout().textContent).toBe(
    m.heat_pump_signature_not_enough_before({ count: '0', needed: '14' }),
  )
})

// The two-chunk range of the test above: a service on 2024-01-10, today 2026-06-01.
const twoChunks = (second: 'fails' | 'pending') => {
  const old: HeatPumpEventDto = {
    id: 'old',
    occurredOn: '2024-01-10',
    heatPumpId: null,
    kind: 'service',
    note: null,
  }
  const qc = makeTestQueryClient()
  qc.setQueryData(heatPumpMonthsQueryFor(null).queryKey, months('2022-10-01'))
  qc.setQueryData(heatPumpEventsQuery.queryKey, [old] as never)
  qc.setQueryData(heatPumpDaysQuery({ from: '2022-12-06', to: '2025-02-12' }).queryKey, {
    units: [],
    days: signatureUnitDays(MATSAL, 0.9, '2023-12-25'),
  } as never)
  // Unseeded, the second chunk fails (no /api/rpc in the test server).
  if (second === 'pending')
    void qc.prefetchQuery({
      queryKey: heatPumpDaysQuery({ from: '2025-02-13', to: '2026-06-01' }).queryKey,
      queryFn: () => new Promise(() => {}),
    })
  return qc
}

test('a failed days chunk: the alert with its retry, and the readout says so instead of loading', async () => {
  const { screen } = await renderWithProviders(<EnergySignatureSection today="2026-06-01" />, {
    queryClient: twoChunks('fails'),
  })
  await expect.element(screen.getByText(m.heat_pump_signature_error_title()).first()).toBeVisible()
  await expect.element(screen.getByRole('button', { name: m.common_try_again() })).toBeVisible()
  await vi.waitFor(() => expect(readout().dataset.state).toBe('error'))
  expect(readout().textContent).toBe(m.heat_pump_signature_error_title())
  expect(
    document.querySelector('[data-slot="signature-chart-placeholder"]')?.className,
  ).not.toMatch(/animate-pulse/)
})

test('one chunk in, the other still loading: loading, never a verdict from half the days', async () => {
  await renderWithProviders(<EnergySignatureSection today="2026-06-01" />, {
    queryClient: twoChunks('pending'),
  })
  await vi.waitFor(() => expect(readout().dataset.state).toBe('loading'))
  // Long enough for a half-days verdict (not_enough_after from chunk one alone) to have rendered.
  await new Promise((resolve) => setTimeout(resolve, 150))
  expect(readout().dataset.state).toBe('loading')
})

test('today is never a complete day: a full-looking today (a manual sync after 23:00) is no point', async () => {
  const qc = seeded([service])
  // 24 of 24 hours on today: qualifies on its own, and would pull the change away from −10 %.
  qc.setQueryData(heatPumpDaysQuery({ from: '2024-12-16', to: TODAY }).queryKey, {
    units: [],
    days: [...signatureUnitDays(MATSAL, 0.9), signatureRow(MATSAL, TODAY, 10, 1)],
  } as never)
  await renderWithProviders(<EnergySignatureSection today={TODAY} />, { queryClient: qc })
  await vi.waitFor(() => expect(readout().dataset.state).toBe('ok'))
  expect(Number(readout().dataset.change)).toBeCloseTo(-0.1, 10)
})
