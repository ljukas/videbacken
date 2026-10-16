import { ORPCError } from '@orpc/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { HeatPumpEventDto } from '~/lib/heatPump/events'
import { heatPumpEventErrorMessage } from '~/lib/orpc/heatPumpEventErrorMessage'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { HeatPumpEventDialog } from './HeatPumpEventDialog'

const { createFn, updateFn, toastMock } = vi.hoisted(() => ({
  createFn: vi.fn(),
  updateFn: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn() },
}))
vi.mock('~/lib/orpc/client', () => ({
  orpc: {
    heatPump: {
      events: {
        create: {
          mutationOptions: (o: Record<string, unknown>) => ({ ...o, mutationFn: createFn }),
        },
        update: {
          mutationOptions: (o: Record<string, unknown>) => ({ ...o, mutationFn: updateFn }),
        },
        key: () => ['heatPump', 'events'],
      },
    },
  },
}))
vi.mock('sonner', () => ({ toast: toastMock }))

const UNITS = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Matsal' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Övervåning' },
]
const EVENT: HeatPumpEventDto = {
  id: 'e1',
  occurredOn: '2026-10-08',
  heatPumpId: UNITS[1].id,
  kind: 'filter',
  note: 'Filter rengjort',
}
const onOpenChange = vi.fn()
const dialog = (mode: Parameters<typeof HeatPumpEventDialog>[0]['mode']) => (
  <HeatPumpEventDialog open mode={mode} units={UNITS} onOpenChange={onOpenChange} />
)
type Screen = Awaited<ReturnType<typeof renderWithProviders>>['screen']
const save = (screen: Screen) => screen.getByRole('button', { name: m.common_save() }).click()
async function choose(screen: Screen, label: string, option: string) {
  await screen.getByRole('combobox', { name: label }).click()
  await screen.getByRole('option', { name: option }).click()
}

// 12:00 in Stockholm on 2026-10-08; only Date is faked.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-08T10:00:00Z'))
  createFn.mockReset().mockResolvedValue({ ...EVENT, id: 'new' })
  updateFn.mockReset().mockResolvedValue(EVENT)
  for (const f of [onOpenChange, toastMock.success, toastMock.error]) f.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
})

test('a new event starts today, for both units, as a service, without a note', async () => {
  const { screen } = await renderWithProviders(dialog({ kind: 'new' }))
  await expect
    .element(screen.getByRole('heading', { name: m.heat_pump_event_dialog_new_title() }))
    .toBeVisible()
  await expect
    .element(screen.getByLabelText(m.heat_pump_event_field_date()))
    .toHaveValue('2026-10-08')
  await expect
    .element(screen.getByRole('combobox', { name: m.heat_pump_event_field_unit() }))
    .toHaveTextContent(m.heat_pump_event_unit_both())
  await expect
    .element(screen.getByRole('combobox', { name: m.heat_pump_event_field_kind() }))
    .toHaveTextContent('Service')
  await expect.element(screen.getByLabelText(m.heat_pump_event_field_note())).toHaveValue('')
})

// Review Focus 1.
test('defaults to the Stockholm day, not the UTC day', async () => {
  vi.setSystemTime(new Date('2026-10-08T22:30:00Z')) // 00:30 on 9 Oct in Stockholm
  const { screen } = await renderWithProviders(dialog({ kind: 'new' }))
  await expect
    .element(screen.getByLabelText(m.heat_pump_event_field_date()))
    .toHaveValue('2026-10-09')
})

test('save sends both units as null and a blank note as null, toasts and closes', async () => {
  const { screen } = await renderWithProviders(dialog({ kind: 'new' }))
  await save(screen)
  await vi.waitFor(() =>
    expect(createFn).toHaveBeenCalledWith(
      { occurredOn: '2026-10-08', heatPumpId: null, kind: 'service', note: null },
      expect.anything(),
    ),
  )
  await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  expect(toastMock.success).toHaveBeenCalledWith(m.heat_pump_event_saved())
})

test('a chosen unit, type and trimmed note are sent', async () => {
  const { screen } = await renderWithProviders(dialog({ kind: 'new' }))
  await screen.getByLabelText(m.heat_pump_event_field_date()).fill('2026-10-01')
  await choose(screen, m.heat_pump_event_field_unit(), 'Matsal')
  await choose(screen, m.heat_pump_event_field_kind(), 'Filterrengöring')
  await screen.getByLabelText(m.heat_pump_event_field_note()).fill('  Filter rengjort  ')
  await save(screen)
  await vi.waitFor(() =>
    expect(createFn).toHaveBeenCalledWith(
      {
        occurredOn: '2026-10-01',
        heatPumpId: UNITS[0].id,
        kind: 'filter',
        note: 'Filter rengjort',
      },
      expect.anything(),
    ),
  )
})

test('a future date is refused in the form, without a request', async () => {
  const { screen } = await renderWithProviders(dialog({ kind: 'new' }))
  await screen.getByLabelText(m.heat_pump_event_field_date()).fill('2026-10-09')
  await save(screen)
  await expect.element(screen.getByText(m.heat_pump_event_error_future())).toBeVisible()
  expect(createFn).not.toHaveBeenCalled()
})

test('an empty date asks for one', async () => {
  const { screen } = await renderWithProviders(dialog({ kind: 'new' }))
  await screen.getByLabelText(m.heat_pump_event_field_date()).fill('')
  await save(screen)
  await expect.element(screen.getByText(m.heat_pump_event_error_date_required())).toBeVisible()
  expect(createFn).not.toHaveBeenCalled()
})

// Review Focus 2.
test('a note over 500 characters is refused in the form; 500 with an emoji is fine', async () => {
  const { screen } = await renderWithProviders(dialog({ kind: 'new' }))
  const note = screen.getByLabelText(m.heat_pump_event_field_note())
  await note.fill('x'.repeat(501))
  await expect
    .element(screen.getByText(m.heat_pump_event_note_count({ count: '501', max: '500' })))
    .toBeVisible()
  await save(screen)
  await expect
    .element(screen.getByText(m.heat_pump_event_error_note_too_long({ max: '500' })))
    .toBeVisible()
  expect(createFn).not.toHaveBeenCalled()
  await note.fill(`${'å'.repeat(499)}🙂`)
  await save(screen)
  await vi.waitFor(() => expect(createFn).toHaveBeenCalledOnce())
})

test('the date picker stops at today; the note grows to a cap, then scrolls', async () => {
  const { screen } = await renderWithProviders(dialog({ kind: 'new' }))
  await expect
    .element(screen.getByLabelText(m.heat_pump_event_field_date()))
    .toHaveAttribute('max', '2026-10-08')
  // No app CSS in browser tests: pin the classes.
  const note = screen.getByLabelText(m.heat_pump_event_field_note()).element()
  expect(note.className).toContain('max-h-48')
  expect(note.className).toContain('overflow-y-auto')
})

test("the note count turns destructive past the max, and stays the note's description", async () => {
  const { screen } = await renderWithProviders(dialog({ kind: 'new' }))
  const note = screen.getByLabelText(m.heat_pump_event_field_note())
  const count = (n: number) =>
    screen.getByText(m.heat_pump_event_note_count({ count: String(n), max: '500' }))
  await note.fill('x'.repeat(500))
  await expect.element(count(500)).toBeVisible()
  expect(count(500).element().closest('.text-destructive')).toBeNull()
  await note.fill('x'.repeat(501))
  await expect.element(count(501)).toBeVisible()
  expect(count(501).element().closest('.text-destructive')).not.toBeNull()
  const describedBy = note.element().getAttribute('aria-describedby') ?? ''
  const description = describedBy
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent)
    .join(' ')
  expect(description).toContain(m.heat_pump_event_note_count({ count: '501', max: '500' }))
})

test('editing pre-fills the event and sends its id', async () => {
  const { screen } = await renderWithProviders(dialog({ kind: 'edit', event: EVENT }))
  await expect
    .element(screen.getByRole('heading', { name: m.heat_pump_event_dialog_edit_title() }))
    .toBeVisible()
  await expect
    .element(screen.getByLabelText(m.heat_pump_event_field_date()))
    .toHaveValue('2026-10-08')
  await expect
    .element(screen.getByRole('combobox', { name: m.heat_pump_event_field_unit() }))
    .toHaveTextContent('Övervåning')
  await expect
    .element(screen.getByLabelText(m.heat_pump_event_field_note()))
    .toHaveValue('Filter rengjort')
  await choose(screen, m.heat_pump_event_field_unit(), m.heat_pump_event_unit_both())
  await save(screen)
  await vi.waitFor(() =>
    expect(updateFn).toHaveBeenCalledWith(
      {
        id: 'e1',
        occurredOn: '2026-10-08',
        heatPumpId: null,
        kind: 'filter',
        note: 'Filter rengjort',
      },
      expect.anything(),
    ),
  )
})

test.each([
  'NOTE_TOO_LONG',
  'UNKNOWN_HEAT_PUMP',
  'FUTURE_DATE',
] as const)('a server %s toasts its message and keeps the dialog open', async (code) => {
  createFn.mockRejectedValue(new ORPCError(code, { defined: true }))
  const { screen } = await renderWithProviders(dialog({ kind: 'new' }))
  await save(screen)
  await vi.waitFor(() =>
    expect(toastMock.error).toHaveBeenCalledWith(heatPumpEventErrorMessage(code)),
  )
  expect(onOpenChange).not.toHaveBeenCalledWith(false)
})

// Review Focus 3.
test('EVENT_NOT_FOUND toasts and closes', async () => {
  updateFn.mockRejectedValue(new ORPCError('EVENT_NOT_FOUND', { defined: true }))
  const { screen } = await renderWithProviders(dialog({ kind: 'edit', event: EVENT }))
  await save(screen)
  await vi.waitFor(() =>
    expect(toastMock.error).toHaveBeenCalledWith(m.heat_pump_event_error_not_found()),
  )
  await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
})

test('an unexpected failure toasts the generic message and keeps the dialog open', async () => {
  createFn.mockRejectedValue(new Error('network'))
  const { screen } = await renderWithProviders(dialog({ kind: 'new' }))
  await save(screen)
  await vi.waitFor(() =>
    expect(toastMock.error).toHaveBeenCalledWith(m.heat_pump_event_save_error()),
  )
  expect(onOpenChange).not.toHaveBeenCalledWith(false)
})
