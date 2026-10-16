import { expect, test, vi } from 'vitest'
import { formatDay } from '~/components/evCharging/format'
import type { HeatPumpEventDto } from '~/lib/heatPump/events'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { HeatPumpEvents } from './HeatPumpEvents'

const UNITS = [
  { id: 'a', name: 'Matsal' },
  { id: 'b', name: 'Övervåning' },
]
const SERVICE: HeatPumpEventDto = {
  id: 'e1',
  occurredOn: '2026-10-08',
  heatPumpId: null,
  kind: 'service',
  note: 'Årlig service',
}
const FILTER: HeatPumpEventDto = {
  id: 'e2',
  occurredOn: '2026-06-01',
  heatPumpId: 'b',
  kind: 'filter',
  note: null,
}
const admin = () => ({ onNew: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() })

test('rows in the given order with date, unit, type and note', async () => {
  const { screen } = await renderWithProviders(
    <HeatPumpEvents events={[SERVICE, FILTER]} units={UNITS} />,
  )
  const items = screen.getByRole('listitem').elements()
  expect(items).toHaveLength(2)
  expect(items[0].textContent).toContain(formatDay('2026-10-08'))
  expect(items[0].textContent).toContain(m.heat_pump_event_unit_both())
  expect(items[0].textContent).toContain('Service')
  expect(items[0].textContent).toContain('Årlig service')
  expect(items[1].textContent).toContain('Övervåning')
  expect(items[1].textContent).toContain('Filterrengöring')
})

test('a member gets no add button and no row actions', async () => {
  const { screen } = await renderWithProviders(
    <HeatPumpEvents events={[SERVICE, FILTER]} units={UNITS} />,
  )
  expect(screen.getByRole('button').elements()).toHaveLength(0)
})

test("two events of one kind on one day tell their menus apart by unit; the heading matches Förbrukning's", async () => {
  const { screen } = await renderWithProviders(
    <HeatPumpEvents
      events={[
        { ...SERVICE, id: 'e3', heatPumpId: 'a' },
        { ...SERVICE, id: 'e4', heatPumpId: 'b' },
      ]}
      units={UNITS}
      admin={admin()}
    />,
  )
  const name = (unit: string) =>
    m.heat_pump_event_actions_for({ kind: 'Service', date: formatDay('2026-10-08'), unit })
  await expect.element(screen.getByRole('button', { name: name('Matsal') })).toBeVisible()
  await expect.element(screen.getByRole('button', { name: name('Övervåning') })).toBeVisible()
  // As EnergySummaryCard's h2 (no app CSS here: pin the classes).
  const title = screen.getByRole('heading', { name: m.heat_pump_events_title() }).element()
  const classes = title.closest('[data-slot="card-title"]')?.className.split(' ') ?? []
  expect(classes).toEqual(expect.arrayContaining(['font-semibold', 'text-lg']))
  expect(classes).not.toContain('font-medium')
  expect(classes).not.toContain('text-base')
})

test('an admin adds from the header and acts on a row from its menu', async () => {
  const actions = admin()
  const { screen } = await renderWithProviders(
    <HeatPumpEvents events={[SERVICE]} units={UNITS} admin={actions} />,
  )
  await screen.getByRole('button', { name: m.heat_pump_events_add() }).click()
  expect(actions.onNew).toHaveBeenCalledOnce()
  const menu = () =>
    screen.getByRole('button', {
      name: m.heat_pump_event_actions_for({
        kind: 'Service',
        date: formatDay('2026-10-08'),
        unit: m.heat_pump_event_unit_both(),
      }),
    })
  await menu().click()
  // No app CSS in browser tests: pin the touch-target class.
  for (const item of screen.getByRole('menuitem').elements()) {
    expect(item.className).toContain('pointer-coarse:min-h-11')
  }
  await screen.getByRole('menuitem', { name: m.common_edit() }).click()
  expect(actions.onEdit).toHaveBeenCalledWith('e1')
  await menu().click()
  await screen.getByRole('menuitem', { name: m.heat_pump_event_delete_action() }).click()
  expect(actions.onDelete).toHaveBeenCalledWith('e1')
})

test('empty: the shared empty state; the admin gets the one next action', async () => {
  const member = await renderWithProviders(<HeatPumpEvents events={[]} units={UNITS} />)
  await expect.element(member.screen.getByText(m.heat_pump_events_empty_title())).toBeVisible()
  await expect
    .element(member.screen.getByText(m.heat_pump_events_empty_description()))
    .toBeVisible()
  expect(member.screen.getByRole('button').elements()).toHaveLength(0)

  const actions = admin()
  const { screen } = await renderWithProviders(
    <HeatPumpEvents events={[]} units={UNITS} admin={actions} />,
  )
  await expect.element(screen.getByText(m.heat_pump_events_empty_description_admin())).toBeVisible()
  // One add button (in the empty state), not a second one in the header.
  const add = screen.getByRole('button', { name: m.heat_pump_events_add() })
  expect(add.elements()).toHaveLength(1)
  await add.click()
  expect(actions.onNew).toHaveBeenCalledOnce()
})
