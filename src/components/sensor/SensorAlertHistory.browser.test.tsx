import { beforeEach, expect, test, vi } from 'vitest'
import type { SensorAlertEventDto } from '~/lib/sensor/alerts'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { alertEventPeriod, alertEventPeriodParts } from './alertRuleCopy'
import { SensorAlertHistory } from './SensorAlertHistory'

// The history read through a stand-in for oRPC's infiniteOptions: each page fetch calls
// `historyFn` with the input the component builds from its page param.
const { historyFn } = vi.hoisted(() => ({ historyFn: vi.fn() }))
vi.mock('~/lib/orpc/client', () => ({
  orpc: {
    sensor: {
      alerts: {
        history: {
          infiniteOptions: ({ input, ...opts }: { input: (p: unknown) => unknown }) => ({
            ...opts,
            queryKey: ['sensor', 'alerts', 'history', input(undefined)],
            queryFn: ({ pageParam }: { pageParam: unknown }) => historyFn(input(pageParam)),
          }),
        },
      },
    },
  },
}))

const DEV = '00000000-0000-4000-8000-0000000000d1'

// Hour-spaced alerts, newest first, each 30 minutes long.
const entry = (i: number, over: Partial<SensorAlertEventDto> = {}): SensorAlertEventDto => {
  const startedAt = new Date(Date.UTC(2026, 9, 19, 20) - i * 3_600_000)
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    kind: 'temperature',
    direction: 'below',
    threshold: 5,
    count: 2,
    silenceHours: null,
    startedAt,
    endedAt: new Date(startedAt.getTime() + 30 * 60_000),
    endReason: 'recovered',
    ...over,
  }
}
const page = (entries: SensorAlertEventDto[], next: SensorAlertEventDto | null = null) => ({
  entries,
  next: next ? { startedAt: next.startedAt, id: next.id } : null,
})

beforeEach(() => {
  historyFn.mockReset()
})

const heading = () => m.sensors_alert_history_heading()

test('ten entries, then "Visa fler" fetches the page before the tenth', async () => {
  const first = Array.from({ length: 10 }, (_, i) => entry(i))
  historyFn.mockImplementation(async (input: { before?: unknown }) =>
    input.before === undefined ? page(first, first[9]) : page([entry(10)]),
  )
  const { screen } = await renderWithProviders(<SensorAlertHistory deviceId={DEV} open />)
  await expect.element(screen.getByRole('heading', { name: heading() })).toBeVisible()
  expect(historyFn).toHaveBeenCalledWith({ deviceId: DEV, before: undefined })
  await expect.poll(() => screen.getByRole('listitem').elements().length).toBe(10)
  await expect.element(screen.getByText(alertEventPeriod(first[0]))).toBeVisible()

  await screen.getByRole('button', { name: m.sensors_alert_history_more() }).click()
  await expect.poll(() => screen.getByRole('listitem').elements().length).toBe(11)
  expect(historyFn).toHaveBeenLastCalledWith({
    deviceId: DEV,
    before: { startedAt: first[9].startedAt, id: first[9].id },
  })
  // The last page: no more to show.
  expect(
    screen.getByRole('button', { name: m.sensors_alert_history_more() }).elements(),
  ).toHaveLength(0)
})

test('"Visa fler" keeps focus while its page loads, then hands it to the first new entry', async () => {
  const first = Array.from({ length: 10 }, (_, i) => entry(i))
  let release: (value: unknown) => void = () => {}
  historyFn.mockImplementation((input: { before?: unknown }) =>
    input.before === undefined
      ? Promise.resolve(page(first, first[9]))
      : new Promise((resolve) => {
          release = resolve
        }),
  )
  const { screen } = await renderWithProviders(<SensorAlertHistory deviceId={DEV} open />)
  const more = screen.getByRole('button', { name: m.sensors_alert_history_more() })
  await expect.element(more).toBeVisible()

  await more.click()
  await expect.element(more).toHaveAttribute('aria-disabled', 'true')
  expect(document.activeElement).toBe(more.element())
  expect(screen.getByRole('region').element().getAttribute('aria-busy')).toBe('true')
  // A second press while it loads fetches nothing more (a DOM click: the locator waits for enabled).
  ;(more.element() as HTMLElement).click()
  expect(historyFn).toHaveBeenCalledTimes(2)

  release(page([entry(10), entry(11)]))
  await expect.poll(() => screen.getByRole('listitem').elements().length).toBe(12)
  await expect.poll(() => more.elements().length).toBe(0)
  await expect
    .poll(() => document.activeElement)
    .toBe(screen.getByRole('listitem').nth(10).element())
})

test('each entry: the rule as it was, its period, and why a quiet end ended', async () => {
  historyFn.mockResolvedValue(
    page([
      entry(0, { endedAt: null, endReason: null }),
      entry(1, { kind: 'humidity', direction: 'above', threshold: 80, endReason: 'edited' }),
    ]),
  )
  const { screen } = await renderWithProviders(<SensorAlertHistory deviceId={DEV} open />)
  await expect.element(screen.getByText('Temperatur under 5 °C · 2 mätningar')).toBeVisible()
  await expect.element(screen.getByText(/ – pågår$/)).toBeVisible()
  await expect.element(screen.getByText('Luftfuktighet över 80 % · 2 mätningar')).toBeVisible()
  await expect.element(screen.getByText(/ · avslutat \(ändrat\)$/)).toBeVisible()
  // Each date and the duration keep to one line; the period wraps between them.
  const nowrap = [...document.querySelectorAll('li:nth-child(2) .whitespace-nowrap')].map(
    (el) => el.textContent,
  )
  const { start, end, duration } = alertEventPeriodParts(entry(1))
  expect(nowrap).toEqual([start, end, duration])
})

test('no entries: nothing renders', async () => {
  historyFn.mockResolvedValue(page([]))
  const { screen } = await renderWithProviders(
    <div data-testid="host">
      <SensorAlertHistory deviceId={DEV} open />
    </div>,
  )
  await vi.waitFor(() => expect(historyFn).toHaveBeenCalled())
  await new Promise((r) => setTimeout(r, 50))
  expect(screen.getByTestId('host').element().childElementCount).toBe(0)
})

test('a failed load: one muted line', async () => {
  historyFn.mockRejectedValue(new Error('boom'))
  const { screen } = await renderWithProviders(<SensorAlertHistory deviceId={DEV} open />)
  await expect.element(screen.getByText(m.sensors_alert_history_failed())).toBeVisible()
  const line = screen.getByText(m.sensors_alert_history_failed()).element()
  expect(line.className).toContain('text-muted-foreground')
  expect(line.getAttribute('role')).toBe('status')
})

test('closed: no fetch', async () => {
  historyFn.mockResolvedValue(page([entry(0)]))
  await renderWithProviders(<SensorAlertHistory deviceId={DEV} open={false} />)
  await new Promise((r) => setTimeout(r, 50))
  expect(historyFn).not.toHaveBeenCalled()
})
