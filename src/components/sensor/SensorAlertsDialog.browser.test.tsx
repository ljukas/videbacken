import { beforeEach, expect, test, vi } from 'vitest'
import type { SensorAlertRuleDto } from '~/lib/sensor/alerts'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { SensorAlertsDialog } from './SensorAlertsDialog'

// Mock the oRPC client so a mutation records its payload instead of hitting the network;
// spreading `opts` keeps the dialog's own onError/onSettled (EditDeviceDialog's idiom).
const { setEnabledFn, toastMock, mutation } = vi.hoisted(() => ({
  mutation: (fn: (vars: unknown) => unknown) => ({
    mutationOptions: (opts: Record<string, unknown>) => ({
      ...opts,
      mutationFn: async (vars: unknown) => fn(vars),
    }),
  }),
  setEnabledFn: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn() },
}))
vi.mock('~/lib/orpc/client', () => ({
  orpc: {
    sensor: {
      alerts: {
        setEnabled: mutation(setEnabledFn),
        create: mutation(vi.fn()),
        update: mutation(vi.fn()),
        delete: mutation(vi.fn()),
        key: () => ['sensor', 'alerts'],
      },
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
  expect(screen.getByRole('switch', { name: 'Larmet på' }).elements()).toHaveLength(4)
})

test('a paused rule shows its switch off', async () => {
  const { screen } = await renderDialog({ rules: [rule({ enabled: false })] })
  await expect
    .element(screen.getByRole('switch', { name: m.sensors_alert_enabled_label() }))
    .not.toBeChecked()
})

test('toggling a switch sets that rule enabled or not', async () => {
  const { screen } = await renderDialog()
  await screen.getByRole('switch', { name: m.sensors_alert_enabled_label() }).first().click()
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
  await screen.getByRole('switch', { name: m.sensors_alert_enabled_label() }).first().click()
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

test("a view that is not one of this sensor's rules shows the list", async () => {
  const { screen } = await renderDialog({ view: '00000000-0000-4000-8000-000000000005' })
  await expect.element(screen.getByText('Tyst i 6 h')).toBeVisible()
  expect(screen.getByRole('button', { name: m.common_save() }).elements()).toHaveLength(0)
})

test('rules still loading: no empty state', async () => {
  const { screen } = await renderDialog({ rules: undefined })
  await expect.element(screen.getByText(m.sensors_alert_rules_loading())).toBeInTheDocument()
  expect(screen.getByText('Inga larm än').elements()).toHaveLength(0)
})

test('rules that failed to load say so, never the empty state', async () => {
  const { screen } = await renderDialog({ rules: undefined, rulesFailed: true })
  await expect.element(screen.getByText(m.sensors_alert_rules_failed())).toBeVisible()
  expect(screen.getByText('Inga larm än').elements()).toHaveLength(0)
})
