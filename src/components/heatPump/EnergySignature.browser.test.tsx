import { expect, test, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { HeatPumpEventDto } from '~/lib/heatPump/events'
import { energySignature, eventsForUnit, type SignatureResult } from '~/lib/heatPump/signature'
import { getIntlLocale } from '~/lib/i18n/format'
import { addDays } from '~/lib/time/stockholm'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { signatureRow, signatureUnitDays } from '~test/fixtures/heatPumpSignature'
import { EnergySignature } from './EnergySignature'
import { eventKindLabel } from './eventCopy'

const MATSAL = 'hp-matsal'
const OVER = 'hp-overvaning'
const units = [
  { id: MATSAL, name: 'Matsal' },
  { id: OVER, name: 'Övervåning' },
]
const ev = (
  over: Partial<HeatPumpEventDto> & { id: string; occurredOn: string },
): HeatPumpEventDto => ({
  heatPumpId: null,
  kind: 'service',
  note: null,
  ...over,
})
const service = ev({ id: 'svc', occurredOn: '2026-01-20' })
const pct = (v: number) =>
  new Intl.NumberFormat(getIntlLocale(), { style: 'percent', maximumFractionDigits: 0 }).format(v)
const readout = () => document.querySelector('[data-slot="signature-readout"]') as HTMLElement
const resultOf = (
  days = signatureUnitDays(MATSAL),
  events = [service],
  eventId = 'svc',
): SignatureResult => energySignature({ days, events, heatPumpId: MATSAL, eventId })

const show = (props: Partial<Parameters<typeof EnergySignature>[0]> = {}) => {
  const onUnitChange = vi.fn()
  const onEventChange = vi.fn()
  const r = renderWithProviders(
    <div style={{ width: 1000 }}>
      <EnergySignature
        units={units}
        unitId={MATSAL}
        onUnitChange={onUnitChange}
        unitEvents={eventsForUnit([service], MATSAL)}
        eventId="svc"
        onEventChange={onEventChange}
        result={resultOf()}
        {...props}
      />
    </div>,
  )
  return { r, onUnitChange, onEventChange }
}

test('the readout: lower consumption, margin rounded up, day counts, raw values on the element', async () => {
  await page.viewport(1440, 900)
  await show().r
  await vi.waitFor(() => expect(readout().dataset.state).toBe('ok'))
  expect(readout().textContent).toBe(
    m.heat_pump_signature_lower({
      event: m.heat_pump_signature_after_service(),
      percent: pct(0.1),
      margin: pct(0.01), // 0,72 % rounds up to 1 %
      after: '14',
      before: '16',
    }),
  )
  expect(Number(readout().dataset.change)).toBeCloseTo(-0.1, 10)
  expect(Number(readout().dataset.margin)).toBeCloseTo(0.784 / 108.5, 10)
})

test('higher consumption reads “högre”', async () => {
  await show({ result: resultOf(signatureUnitDays(MATSAL, 1.1)) }).r
  await vi.waitFor(() =>
    expect(readout().textContent).toBe(
      m.heat_pump_signature_higher({
        event: m.heat_pump_signature_after_service(),
        percent: pct(0.1),
        margin: pct(0.01),
        after: '14',
        before: '16',
      }),
    ),
  )
})

test('the unit toggle names each unit with its colour swatch and reports a switch', async () => {
  const { r, onUnitChange } = show()
  const { screen } = await r
  await expect
    .element(screen.getByRole('radio', { name: 'Matsal' }))
    .toHaveAttribute('aria-checked', 'true')
  const swatches = [...document.querySelectorAll('[data-unit-swatch]')].map(
    (s) => (s as HTMLElement).style.background,
  )
  expect(swatches).toEqual(['var(--energy-heat-pump-1)', 'var(--energy-heat-pump-2)'])
  await userEvent.click(screen.getByRole('radio', { name: 'Övervåning' }))
  expect(onUnitChange).toHaveBeenCalledWith(OVER)
})

test('the event select lists the unit’s events newest first and reports a choice', async () => {
  const older = ev({ id: 'old', occurredOn: '2025-10-01' })
  const later = ev({ id: 'set', occurredOn: '2026-03-01', heatPumpId: MATSAL, kind: 'setting' })
  const unitEvents = eventsForUnit([older, service, later], MATSAL)
  const { r, onEventChange } = show({ unitEvents })
  const { screen } = await r
  const trigger = screen.getByRole('combobox', { name: m.heat_pump_signature_event_label() })
  await vi.waitFor(() => expect(trigger.element().textContent).toContain(eventKindLabel('service')))
  await userEvent.click(trigger)
  const options = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent ?? '')
  expect(options).toHaveLength(3)
  expect(options[0]).toContain(eventKindLabel('setting'))
  expect(options[2]).toContain('2025')
  await userEvent.click(screen.getByRole('option', { name: new RegExp(eventKindLabel('setting')) }))
  expect(onEventChange).toHaveBeenCalledWith('set')
})

test('loading: the loading line and a chart-sized placeholder, no chart', async () => {
  await show({ result: null }).r
  await vi.waitFor(() => expect(readout().dataset.state).toBe('loading'))
  expect(readout().textContent).toBe(m.heat_pump_signature_loading())
  expect(document.querySelector('[data-chart="scatter"]')).toBeNull()
  const placeholder = document.querySelector<HTMLElement>(
    '[data-slot="signature-chart-placeholder"]',
  )
  expect(placeholder?.style.height).toBe('300px')
})

test('no event for the unit: the no-event line and no chart', async () => {
  await show({ unitEvents: [], eventId: null, result: null }).r
  await vi.waitFor(() => expect(readout().dataset.state).toBe('no_event'))
  expect(readout().textContent).toBe(m.heat_pump_signature_no_event({ unit: 'Matsal' }))
  expect(document.querySelector('[data-chart="scatter"]')).toBeNull()
})

test('a summer after the event: 0 of 14 days, hollow after-days, the before line only', async () => {
  const summer = [
    ...signatureUnitDays(MATSAL).slice(0, 16),
    ...Array.from({ length: 14 }, (_, i) => signatureRow(MATSAL, addDays('2026-01-21', i), 25, 12)),
  ]
  await show({ result: resultOf(summer) }).r
  await vi.waitFor(() => expect(readout().dataset.state).toBe('not_enough_after'))
  expect(readout().textContent).toBe(
    m.heat_pump_signature_not_enough_after({ count: '0', needed: '14' }),
  )
  await vi.waitFor(() => expect(document.querySelectorAll('[data-extrapolated]')).toHaveLength(14))
  expect(
    [...document.querySelectorAll('[data-fit]')].map((e) => e.getAttribute('data-fit')),
  ).toEqual(['before'])
})

test('too few before-days says so with the count', async () => {
  await show({ result: resultOf(signatureUnitDays(MATSAL).slice(5)) }).r
  await vi.waitFor(() =>
    expect(readout().textContent).toBe(
      m.heat_pump_signature_not_enough_before({ count: '11', needed: '14' }),
    ),
  )
})

test('one unit: no toggle; the table lists every point with its period', async () => {
  const days = [...signatureUnitDays(MATSAL), signatureRow(MATSAL, '2026-02-04', 25, 12)]
  const { screen } = await show({ units: [units[0]], result: resultOf(days) }).r
  expect(screen.container.querySelector('[role="radiogroup"]')).toBeNull()
  await userEvent.click(screen.getByText(m.energy_flow_table_toggle()))
  const rows = [...document.querySelectorAll('tbody tr')]
  expect(rows).toHaveLength(31)
  expect(rows[0].textContent).toContain(m.heat_pump_signature_before())
  expect(rows.at(-1)?.textContent).toContain(
    m.heat_pump_signature_table_not_counted({ set: m.heat_pump_signature_after() }),
  )
})
