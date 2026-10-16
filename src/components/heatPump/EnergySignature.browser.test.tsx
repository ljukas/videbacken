import { QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, test, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { HeatPumpEventDto } from '~/lib/heatPump/events'
import { energySignature, eventsForUnit, type SignatureResult } from '~/lib/heatPump/signature'
import { getIntlLocale } from '~/lib/i18n/format'
import { addDays } from '~/lib/time/stockholm'
import { m } from '~/paraglide/messages'
import { tapOn, tooltipText } from '~test/browser/chartDom'
import { renderWithProviders } from '~test/browser/render'
import { signatureRow, signatureUnitDays } from '~test/fixtures/heatPumpSignature'
import { EnergySignature, signatureReadout } from './EnergySignature'
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

test('no event for the unit: the no-event line in the same box, no chart', async () => {
  const { screen } = await show({ unitEvents: [], eventId: null, result: null }).r
  await vi.waitFor(() => expect(readout().dataset.state).toBe('no_event'))
  expect(readout().textContent).toBe(m.heat_pump_signature_no_event({ unit: 'Matsal' }))
  expect(document.querySelector('[data-chart="scatter"]')).toBeNull()
  // The loaded card's box: a static chart-sized placeholder, the note, the table toggle.
  const placeholder = document.querySelector<HTMLElement>(
    '[data-slot="signature-chart-placeholder"]',
  )
  expect(placeholder?.style.height).toBe('300px')
  expect(placeholder?.className).not.toMatch(/animate-pulse/)
  await expect.element(screen.getByText(m.heat_pump_signature_note())).toBeInTheDocument()
  await expect.element(screen.getByText(m.energy_flow_table_toggle())).toBeInTheDocument()
})

test('one live region for every state: the same element, polite and atomic, only its text changes', async () => {
  const { r } = show({ result: null })
  const { screen, queryClient } = await r
  await vi.waitFor(() => expect(readout().dataset.state).toBe('loading'))
  const region = readout()
  expect(region.getAttribute('aria-live')).toBe('polite')
  expect(region.getAttribute('aria-atomic')).toBe('true')
  const at = (props: Partial<Parameters<typeof EnergySignature>[0]>) =>
    screen.rerender(
      <QueryClientProvider client={queryClient}>
        <div style={{ width: 1000 }}>
          <EnergySignature
            units={units}
            unitId={MATSAL}
            onUnitChange={() => {}}
            unitEvents={eventsForUnit([service], MATSAL)}
            eventId="svc"
            onEventChange={() => {}}
            result={null}
            {...props}
          />
        </div>
      </QueryClientProvider>,
    )
  await at({ result: resultOf() })
  await vi.waitFor(() => expect(readout().dataset.state).toBe('ok'))
  expect(readout()).toBe(region)
  await at({ result: null, failed: true })
  await vi.waitFor(() => expect(readout().dataset.state).toBe('error'))
  expect(readout()).toBe(region)
  expect(region.dataset.change).toBeUndefined()
  await at({ unitEvents: [], eventId: null, result: null })
  await vi.waitFor(() => expect(readout().dataset.state).toBe('no_event'))
  expect(readout()).toBe(region)
  expect(document.querySelectorAll('[data-slot="signature-readout"]')).toHaveLength(1)
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

test('switching event closes an open tooltip instead of moving it to another day', async () => {
  await page.viewport(1440, 900)
  const older = ev({ id: 'old', occurredOn: '2025-12-20' })
  const unitEvents = eventsForUnit([older, service], MATSAL)
  const { screen, queryClient } = await show({ unitEvents }).r
  await vi.waitFor(() =>
    expect(document.querySelectorAll('[data-point]').length).toBeGreaterThan(0),
  )
  // A tap (touch keeps the card open: there is no pointerleave to close it).
  tapOn(screen.container, () => document.querySelector('[data-point="2026-01-12"]') as Element)
  await vi.waitFor(() => expect(tooltipText()).toContain(m.heat_pump_signature_tooltip_delta()))
  // The other event's result (as a keyboard choice brings it: no tap outside closes the card first).
  // The same point indices now hold other days. Same providers, so React updates in place.
  const shifted = signatureUnitDays(MATSAL, 0.9, '2025-12-01')
  await screen.rerender(
    <QueryClientProvider client={queryClient}>
      <div style={{ width: 1000 }}>
        <EnergySignature
          units={units}
          unitId={MATSAL}
          onUnitChange={() => {}}
          unitEvents={unitEvents}
          eventId="old"
          onEventChange={() => {}}
          result={energySignature({
            days: shifted,
            events: [older, service],
            heatPumpId: MATSAL,
            eventId: 'old',
          })}
          failed={false}
        />
      </div>
    </QueryClientProvider>,
  )
  await vi.waitFor(() => expect(tooltipText()).toBe(''))
})

test('the header follows the sibling cards: title, description, the controls as the card action', async () => {
  const { screen } = await show().r
  const title = document.querySelector('[data-slot="card-title"]')
  expect(title?.querySelector('h2')?.textContent).toBe(m.heat_pump_signature_title())
  expect(document.querySelector('[data-slot="card-description"]')?.textContent).toBe(
    m.heat_pump_signature_description(),
  )
  const action = document.querySelector('[data-slot="card-action"]') as HTMLElement
  expect(action.querySelector('[role="radiogroup"]')).not.toBeNull()
  // The select is named by its visible label, not by a second, hidden name.
  const trigger = screen.getByRole('combobox', { name: m.heat_pump_signature_event_label() })
  const el = trigger.element()
  expect(action.contains(el)).toBe(true)
  expect(el.getAttribute('aria-label')).toBeNull()
  const label = document.getElementById(el.getAttribute('aria-labelledby') ?? '')
  expect(label?.textContent).toBe(m.heat_pump_signature_event_label())
  expect(label?.closest('[aria-hidden]')).toBeNull()
})

test('no event: the event control’s place is held, hidden, so the header keeps its height', async () => {
  await show({ unitEvents: [], eventId: null, result: null }).r
  await vi.waitFor(() => expect(readout().dataset.state).toBe('no_event'))
  expect(document.querySelector('[role="combobox"]')).toBeNull()
  const held = document.querySelector('[data-slot="signature-event-control"]') as HTMLElement
  expect(held.getAttribute('aria-hidden')).toBe('true')
  expect(held.className).toMatch(/\binvisible\b/)
})

test('touch targets: the unit toggle, the select and the table toggle grow to 44 px on touch', async () => {
  await show().r
  const coarse = (el: Element | null) => el?.getAttribute('class') ?? ''
  for (const item of document.querySelectorAll('[role="radio"]'))
    expect(coarse(item)).toMatch(/pointer-coarse:min-h-11/)
  expect(coarse(document.querySelector('[role="combobox"]'))).toMatch(/pointer-coarse:min-h-11/)
  expect(coarse(document.querySelector('summary'))).toMatch(/pointer-coarse:min-h-11/)
})

describe('signatureReadout', () => {
  const okWith = (change: number, margin = 0.01): SignatureResult => ({
    state: 'ok',
    points: [],
    fit: { a: 2, b: 0.5 },
    afterFit: null,
    change,
    margin,
    beforeDays: 16,
    afterDays: 14,
  })
  const params = (percent: number, margin: number) => ({
    event: m.heat_pump_signature_after_service(),
    percent: pct(percent),
    margin: pct(margin),
    after: '14',
    before: '16',
  })

  test('a change under half a percent either way reads “no difference”; half a percent is 1 %', () => {
    expect(signatureReadout(okWith(-0.004), 'service')).toBe(
      m.heat_pump_signature_same(params(0, 0.01)),
    )
    expect(signatureReadout(okWith(0.004), 'service')).toBe(
      m.heat_pump_signature_same(params(0, 0.01)),
    )
    expect(signatureReadout(okWith(0.005), 'service')).toBe(
      m.heat_pump_signature_higher(params(0.01, 0.01)),
    )
  })

  test('the margin is rounded up to a whole percent, 1 % at the least', () => {
    const margin = (v: number) => signatureReadout(okWith(-0.1, v), 'service')
    expect(margin(0.0001)).toBe(m.heat_pump_signature_lower(params(0.1, 0.01)))
    expect(margin(0.01)).toBe(m.heat_pump_signature_lower(params(0.1, 0.01)))
    expect(margin(0.0101)).toBe(m.heat_pump_signature_lower(params(0.1, 0.02)))
    expect(margin(0.032)).toBe(m.heat_pump_signature_lower(params(0.1, 0.04)))
  })

  test('not enough before: the count under 14 days, the spread copy from 14', () => {
    expect(
      signatureReadout({ state: 'not_enough_before', before: 13, points: [] }, 'service'),
    ).toBe(m.heat_pump_signature_not_enough_before({ count: '13', needed: '14' }))
    const spread = signatureReadout(
      { state: 'not_enough_before', before: 19, points: [] },
      'service',
    )
    expect(spread).toBe(m.heat_pump_signature_not_enough_before_spread({ span: '4' }))
    expect(spread).toContain('4')
  })
})
