import { QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { SensorAlertRuleDto } from '~/lib/sensor/alerts'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { SensorAlertsDialog } from './SensorAlertsDialog'

// Mock the oRPC client so a mutation records its payload instead of hitting the network;
// spreading `opts` keeps the dialog's own onError/onSettled (EditDeviceDialog's idiom).
const { setEnabledFn, updateFn, toastMock, mutation } = vi.hoisted(() => ({
  mutation: (fn: (vars: unknown) => unknown) => ({
    mutationOptions: (opts: Record<string, unknown>) => ({
      ...opts,
      mutationFn: async (vars: unknown) => fn(vars),
    }),
  }),
  setEnabledFn: vi.fn(),
  updateFn: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn() },
}))
vi.mock('~/lib/orpc/client', () => ({
  orpc: {
    sensor: {
      alerts: {
        setEnabled: mutation(setEnabledFn),
        create: mutation(vi.fn()),
        update: mutation(updateFn),
        delete: mutation(vi.fn()),
        key: () => ['sensor', 'alerts'],
      },
      listDevices: { key: () => ['sensor', 'listDevices'] },
    },
  },
}))
vi.mock('sonner', () => ({ toast: toastMock }))

const DEV = '00000000-0000-4000-8000-0000000000d1'
const OTHER_DEV = '00000000-0000-4000-8000-0000000000d2'
const device = { id: DEV, displayName: 'Förråd' }

const rule = (over: Partial<SensorAlertRuleDto>): SensorAlertRuleDto => ({
  id: '00000000-0000-4000-8000-000000000001',
  deviceId: DEV,
  kind: 'temperature',
  enabled: true,
  direction: 'below',
  threshold: 5,
  count: 2,
  silenceHours: null,
  ...over,
})
const RULES: SensorAlertRuleDto[] = [
  rule({ id: '00000000-0000-4000-8000-000000000001' }),
  rule({
    id: '00000000-0000-4000-8000-000000000002',
    kind: 'humidity',
    direction: 'above',
    threshold: 80,
    count: 3,
  }),
  rule({ id: '00000000-0000-4000-8000-000000000003', kind: 'battery', threshold: 20, count: 2 }),
  rule({
    id: '00000000-0000-4000-8000-000000000004',
    kind: 'silence',
    direction: null,
    threshold: null,
    count: null,
    silenceHours: 6,
  }),
  rule({ id: '00000000-0000-4000-8000-000000000005', deviceId: OTHER_DEV, threshold: -10 }),
]

beforeEach(() => {
  setEnabledFn.mockReset()
  updateFn.mockReset()
  toastMock.success.mockReset()
  toastMock.error.mockReset()
})

function renderDialog(
  over: Partial<Parameters<typeof SensorAlertsDialog>[0]> = {},
): ReturnType<typeof renderWithProviders> {
  return renderWithProviders(
    <SensorAlertsDialog
      open
      device={device}
      rules={RULES}
      typicalGapMinutes={{ [DEV]: 120 }}
      view="list"
      onView={() => {}}
      onClose={() => {}}
      {...over}
    />,
  )
}

test('the list names the sensor and shows only its rules, each with a switch', async () => {
  const { screen } = await renderDialog()
  await expect.element(screen.getByRole('heading', { name: 'Larm för Förråd' })).toBeVisible()
  await expect.element(screen.getByText('Bara du får dessa mejl.')).toBeVisible()
  await expect.element(screen.getByText('Temperatur under 5 °C · 2 mätningar')).toBeVisible()
  await expect.element(screen.getByText('Luftfuktighet över 80 % · 3 mätningar')).toBeVisible()
  await expect.element(screen.getByText('Batteri under 20 % · 2 mätningar')).toBeVisible()
  await expect.element(screen.getByText('Tyst i 6 h')).toBeVisible()
  // Another sensor's rule stays out.
  expect(screen.getByText(/−10/).elements()).toHaveLength(0)
  expect(screen.getByRole('switch').elements()).toHaveLength(4)
})

test('each switch is named by its rule, so a screen reader tells them apart', async () => {
  const { screen } = await renderDialog()
  await expect
    .element(
      screen.getByRole('switch', {
        name: m.sensors_alert_enabled_named({
          description: 'Luftfuktighet över 80 % · 3 mätningar',
        }),
      }),
    )
    .toBeChecked()
})

test('a paused rule shows its switch off', async () => {
  const { screen } = await renderDialog({ rules: [rule({ enabled: false })] })
  await expect.element(screen.getByRole('switch')).not.toBeChecked()
})

test('toggling a switch sets that rule enabled or not', async () => {
  const { screen } = await renderDialog()
  await screen.getByRole('switch').first().click()
  await vi.waitFor(() =>
    expect(setEnabledFn).toHaveBeenCalledWith({
      id: '00000000-0000-4000-8000-000000000001',
      enabled: false,
    }),
  )
})

test('a failing switch toasts the error', async () => {
  setEnabledFn.mockRejectedValue(new Error('boom'))
  const { screen } = await renderDialog()
  await screen.getByRole('switch').first().click()
  await vi.waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(m.sensors_alert_save_error()))
})

test('tapping a rule opens it in the form', async () => {
  const onView = vi.fn()
  const { screen } = await renderDialog({ onView })
  await screen.getByRole('button', { name: 'Luftfuktighet över 80 % · 3 mätningar' }).click()
  expect(onView).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000002')
})

test('"Nytt larm" opens the empty form', async () => {
  const onView = vi.fn()
  const { screen } = await renderDialog({ onView })
  await screen.getByRole('button', { name: 'Nytt larm' }).click()
  expect(onView).toHaveBeenCalledWith('new')
})

test('no rules for this sensor: the empty state, with the same button', async () => {
  const onView = vi.fn()
  const { screen } = await renderDialog({ rules: [RULES[4]], onView })
  await expect.element(screen.getByText('Inga larm än')).toBeVisible()
  await expect
    .element(screen.getByText('Lägg till ett larm så mejlar vi dig när Förråd behöver tillsyn.'))
    .toBeVisible()
  await screen.getByRole('button', { name: 'Nytt larm' }).click()
  expect(onView).toHaveBeenCalledWith('new')
})

test("a rule that is gone (or another sensor's) toasts once and returns to the list", async () => {
  const onView = vi.fn()
  const { screen, queryClient } = await renderDialog({
    view: '00000000-0000-4000-8000-000000000005',
    onView,
  })
  await expect.element(screen.getByText('Tyst i 6 h')).toBeVisible()
  expect(screen.getByRole('button', { name: m.common_save() }).elements()).toHaveLength(0)
  await vi.waitFor(() =>
    expect(toastMock.error).toHaveBeenCalledWith(m.sensors_alert_error_rule_not_found()),
  )
  expect(onView).toHaveBeenCalledWith('list', { replace: true })
  // A re-render with the same stale view doesn't toast again.
  await screen.rerender(
    <QueryClientProvider client={queryClient}>
      <SensorAlertsDialog
        open
        device={device}
        rules={[...RULES]}
        typicalGapMinutes={{ [DEV]: 120 }}
        view="00000000-0000-4000-8000-000000000005"
        onView={onView}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  )
  expect(toastMock.error).toHaveBeenCalledTimes(1)
})

test('an unknown view while the rules still load waits, without a toast', async () => {
  const onView = vi.fn()
  await renderDialog({ rules: undefined, view: '00000000-0000-4000-8000-000000000009', onView })
  await new Promise((r) => setTimeout(r, 50))
  expect(toastMock.error).not.toHaveBeenCalled()
  expect(onView).not.toHaveBeenCalled()
})

test('rules still loading: no empty state, and the spinner stays out of the reading order', async () => {
  const { screen } = await renderDialog({ rules: undefined })
  await expect.element(screen.getByText(m.sensors_alert_rules_loading())).toBeInTheDocument()
  expect(screen.getByText('Inga larm än').elements()).toHaveLength(0)
  // The visible text says it; the spinner's own "Loading" status would say it twice.
  expect(screen.getByRole('status').elements()).toHaveLength(0)
})

test('rules that failed to load say so with a retry, never the empty state', async () => {
  const onRetryRules = vi.fn()
  const { screen } = await renderDialog({ rules: undefined, rulesFailed: true, onRetryRules })
  await expect
    .element(screen.getByRole('alert').getByText(m.sensors_alert_rules_failed()))
    .toBeVisible()
  expect(screen.getByText('Inga larm än').elements()).toHaveLength(0)
  await screen.getByRole('button', { name: m.common_try_again() }).click()
  expect(onRetryRules).toHaveBeenCalledTimes(1)
})

// The dialog as the route drives it: the view lives in state, as it does in the URL.
function Stateful({
  initial = 'list',
  rules = RULES,
}: {
  initial?: string
  rules?: SensorAlertRuleDto[]
}) {
  const [view, setView] = useState(initial)
  return (
    <SensorAlertsDialog
      open
      device={device}
      rules={rules}
      typicalGapMinutes={{ [DEV]: 120 }}
      view={view}
      onView={setView}
      onClose={() => {}}
    />
  )
}

test('the form takes focus on its heading; back in the list, focus returns to "Nytt larm"', async () => {
  const { screen } = await renderWithProviders(<Stateful />)
  await screen.getByRole('button', { name: 'Nytt larm' }).click()
  const heading = screen.getByRole('heading', { name: m.sensors_alert_form_title_new() })
  await expect.element(heading).toHaveFocus()
  await screen.getByRole('button', { name: m.common_back() }).click()
  await expect.element(screen.getByRole('button', { name: 'Nytt larm' })).toHaveFocus()
})

test('back from editing a rule focuses that rule in the list', async () => {
  const { screen } = await renderWithProviders(<Stateful />)
  await screen.getByRole('button', { name: 'Luftfuktighet över 80 % · 3 mätningar' }).click()
  await expect
    .element(screen.getByRole('heading', { name: m.sensors_alert_form_title_edit() }))
    .toHaveFocus()
  await screen.getByRole('button', { name: m.common_back() }).click()
  await expect
    .element(screen.getByRole('button', { name: 'Luftfuktighet över 80 % · 3 mätningar' }))
    .toHaveFocus()
})

test('Esc in the form returns to the list instead of closing', async () => {
  const onView = vi.fn()
  const onClose = vi.fn()
  const { screen } = await renderDialog({ view: 'new', onView, onClose })
  await expect
    .element(screen.getByRole('heading', { name: m.sensors_alert_form_title_new() }))
    .toHaveFocus()
  await userEvent.keyboard('{Escape}')
  expect(onView).toHaveBeenCalledWith('list', { replace: true })
  expect(onClose).not.toHaveBeenCalled()
})

test('Esc in the list closes the dialog', async () => {
  const onClose = vi.fn()
  const { screen } = await renderDialog({ onClose })
  await expect.element(screen.getByRole('button', { name: 'Nytt larm' })).toBeVisible()
  await userEvent.keyboard('{Escape}')
  expect(onClose).toHaveBeenCalledTimes(1)
})

test('a rule left on purpose and opened again still toasts when it vanishes later', async () => {
  const HUMID = 'Luftfuktighet över 80 % · 3 mätningar'
  const { screen, queryClient } = await renderWithProviders(<Stateful />)
  await screen.getByRole('button', { name: HUMID }).click()
  await screen.getByRole('button', { name: m.common_back() }).click()
  await screen.getByRole('button', { name: HUMID }).click()
  await expect
    .element(screen.getByRole('heading', { name: m.sensors_alert_form_title_edit() }))
    .toBeVisible()
  // Deleted in another tab: the next poll drops it.
  await screen.rerender(
    <QueryClientProvider client={queryClient}>
      <Stateful rules={RULES.filter((r) => r.id !== '00000000-0000-4000-8000-000000000002')} />
    </QueryClientProvider>,
  )
  await vi.waitFor(() =>
    expect(toastMock.error).toHaveBeenCalledWith(m.sensors_alert_error_rule_not_found()),
  )
  await expect.element(screen.getByRole('button', { name: 'Nytt larm' })).toBeVisible()
})

test('Esc while a save is on its way does nothing', async () => {
  updateFn.mockReturnValue(new Promise(() => {}))
  const onView = vi.fn()
  const onClose = vi.fn()
  const { screen } = await renderDialog({
    view: '00000000-0000-4000-8000-000000000001',
    onView,
    onClose,
  })
  await screen.getByRole('button', { name: m.common_save() }).click()
  await vi.waitFor(() => expect(updateFn).toHaveBeenCalled())
  await userEvent.keyboard('{Escape}')
  expect(onView).not.toHaveBeenCalled()
  expect(onClose).not.toHaveBeenCalled()
})

test('a double Esc steps back once, never past the list', async () => {
  const onView = vi.fn()
  const { screen } = await renderDialog({ view: 'new', onView })
  await expect
    .element(screen.getByRole('heading', { name: m.sensors_alert_form_title_new() }))
    .toHaveFocus()
  // Before the URL (and so the view) catches up, the second press must do nothing.
  await userEvent.keyboard('{Escape}{Escape}')
  expect(onView).toHaveBeenCalledTimes(1)
  expect(onView).toHaveBeenCalledWith('list', { replace: true })
})

test("a save from a form that is gone doesn't step the next form back", async () => {
  let land = (_v: unknown) => {}
  updateFn.mockReturnValue(
    new Promise((resolve) => {
      land = resolve
    }),
  )
  const onView = vi.fn()
  const RULE_1 = '00000000-0000-4000-8000-000000000001'
  const { screen, queryClient } = await renderDialog({ view: RULE_1, onView })
  await screen.getByRole('button', { name: m.common_save() }).click()
  await vi.waitFor(() => expect(updateFn).toHaveBeenCalled())
  // The user moves on (closed and reopened, then "Nytt larm"): that form replaces this one.
  await screen.rerender(
    <QueryClientProvider client={queryClient}>
      <SensorAlertsDialog
        open
        device={device}
        rules={RULES}
        typicalGapMinutes={{ [DEV]: 120 }}
        view="new"
        onView={onView}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  )
  await expect
    .element(screen.getByRole('heading', { name: m.sensors_alert_form_title_new() }))
    .toBeVisible()
  land({ id: RULE_1 })
  await vi.waitFor(() => expect(toastMock.success).toHaveBeenCalled())
  await new Promise((r) => setTimeout(r, 50))
  expect(onView).not.toHaveBeenCalled()
  await expect
    .element(screen.getByRole('heading', { name: m.sensors_alert_form_title_new() }))
    .toBeVisible()
})
