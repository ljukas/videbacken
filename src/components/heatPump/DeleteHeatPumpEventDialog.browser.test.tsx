import { ORPCError } from '@orpc/client'
import { beforeEach, expect, test, vi } from 'vitest'
import { formatDay } from '~/components/evCharging/format'
import type { HeatPumpEventDto } from '~/lib/heatPump/events'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { DeleteHeatPumpEventDialog } from './DeleteHeatPumpEventDialog'

const { deleteFn, toastMock } = vi.hoisted(() => ({
  deleteFn: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn() },
}))
vi.mock('~/lib/orpc/client', () => ({
  orpc: {
    heatPump: {
      events: {
        delete: {
          mutationOptions: (o: Record<string, unknown>) => ({ ...o, mutationFn: deleteFn }),
        },
        key: () => ['heatPump', 'events'],
      },
    },
  },
}))
vi.mock('sonner', () => ({ toast: toastMock }))

const UNITS = [
  { id: 'a', name: 'Matsal' },
  { id: 'b', name: 'Övervåning' },
]
const EVENT: HeatPumpEventDto = {
  id: 'e1',
  occurredOn: '2026-10-08',
  heatPumpId: null,
  kind: 'service',
  note: null,
}
const onOpenChange = vi.fn()
beforeEach(() => {
  deleteFn.mockReset().mockResolvedValue(undefined)
  for (const f of [onOpenChange, toastMock.success, toastMock.error]) f.mockReset()
})

test('names what it deletes; confirming deletes, toasts and closes', async () => {
  const { screen } = await renderWithProviders(
    <DeleteHeatPumpEventDialog open event={EVENT} units={UNITS} onOpenChange={onOpenChange} />,
  )
  const confirm = screen.getByRole('alertdialog')
  await expect
    .element(
      confirm.getByText(
        m.heat_pump_event_delete_confirm({
          kind: 'Service',
          date: formatDay('2026-10-08'),
          unit: 'Båda',
        }),
      ),
    )
    .toBeVisible()
  await confirm.getByRole('button', { name: m.heat_pump_event_delete_action() }).click()
  await vi.waitFor(() => expect(deleteFn).toHaveBeenCalledWith({ id: 'e1' }, expect.anything()))
  expect(onOpenChange).toHaveBeenCalledWith(false)
  await vi.waitFor(() =>
    expect(toastMock.success).toHaveBeenCalledWith(m.heat_pump_event_deleted()),
  )
})

test('cancel deletes nothing', async () => {
  const { screen } = await renderWithProviders(
    <DeleteHeatPumpEventDialog open event={EVENT} units={UNITS} onOpenChange={onOpenChange} />,
  )
  await screen.getByRole('button', { name: m.common_cancel() }).click()
  expect(deleteFn).not.toHaveBeenCalled()
})

test('an event already gone counts as deleted: the deleted toast, no error', async () => {
  deleteFn.mockRejectedValue(new ORPCError('EVENT_NOT_FOUND', { defined: true }))
  const { screen } = await renderWithProviders(
    <DeleteHeatPumpEventDialog open event={EVENT} units={UNITS} onOpenChange={onOpenChange} />,
  )
  await screen.getByRole('button', { name: m.heat_pump_event_delete_action() }).click()
  await vi.waitFor(() =>
    expect(toastMock.success).toHaveBeenCalledWith(m.heat_pump_event_deleted()),
  )
  expect(toastMock.error).not.toHaveBeenCalled()
})

test('a failed delete toasts the generic message', async () => {
  deleteFn.mockRejectedValue(new Error('network'))
  const { screen } = await renderWithProviders(
    <DeleteHeatPumpEventDialog open event={EVENT} units={UNITS} onOpenChange={onOpenChange} />,
  )
  await screen.getByRole('button', { name: m.heat_pump_event_delete_action() }).click()
  await vi.waitFor(() =>
    expect(toastMock.error).toHaveBeenCalledWith(m.heat_pump_event_delete_error()),
  )
  expect(toastMock.success).not.toHaveBeenCalled()
})
