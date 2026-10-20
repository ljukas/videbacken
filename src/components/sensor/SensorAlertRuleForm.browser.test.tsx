import { ORPCError } from '@orpc/client'
import { beforeEach, expect, test, vi } from 'vitest'
import type { SensorAlertRuleDto } from '~/lib/sensor/alerts'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { SensorAlertsDialog } from './SensorAlertsDialog'

// The form renders inside the dialog (its 'new' or rule-id view). oRPC is mocked so a save
// records its payload or fails on demand; spreading `opts` keeps the form's onError/onSettled.
const { createFn, updateFn, deleteFn, toastMock, mutation } = vi.hoisted(() => ({
  mutation: (fn: (vars: unknown) => unknown) => ({
    mutationOptions: (opts: Record<string, unknown>) => ({
      ...opts,
      mutationFn: async (vars: unknown) => fn(vars),
    }),
  }),
  createFn: vi.fn(),
  updateFn: vi.fn(),
  deleteFn: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn() },
}))
vi.mock('~/lib/orpc/client', () => ({
  orpc: {
    sensor: {
      alerts: {
        setEnabled: mutation(vi.fn()),
        create: mutation(createFn),
        update: mutation(updateFn),
        delete: mutation(deleteFn),
        key: () => ['sensor', 'alerts'],
      },
    },
  },
}))
vi.mock('sonner', () => ({ toast: toastMock }))

const DEV = '00000000-0000-4000-8000-0000000000d1'
const device = { id: DEV, displayName: 'Förråd' }
const HUMIDITY: SensorAlertRuleDto = {
  id: '00000000-0000-4000-8000-000000000002',
  deviceId: DEV,
  kind: 'humidity',
  enabled: true,
  direction: 'above',
  threshold: 80,
  count: 3,
  silenceHours: null,
}
const TEMPERATURE: SensorAlertRuleDto = {
  ...HUMIDITY,
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'temperature',
  direction: 'below',
  threshold: 4.5,
  count: 2,
}

beforeEach(() => {
  for (const fn of [createFn, updateFn, deleteFn, toastMock.success, toastMock.error]) {
    fn.mockReset()
  }
})

function renderForm({
  view = 'new',
  gap = 120,
  onView = () => {},
}: {
  view?: string
  gap?: number | null
  onView?: (view: string) => void
} = {}) {
  return renderWithProviders(
    <SensorAlertsDialog
      open
      device={device}
      rules={[TEMPERATURE, HUMIDITY]}
      typicalGapMinutes={{ [DEV]: gap }}
      view={view}
      onView={onView}
      onClose={() => {}}
    />,
  )
}

test('a new temperature rule: under, "4,5", 2 in a row', async () => {
  const onView = vi.fn()
  const { screen } = await renderForm({ onView })
  await expect.element(screen.getByRole('radio', { name: 'Temperatur' })).toBeChecked()
  await screen.getByRole('radio', { name: 'under' }).click()
  await screen.getByLabelText('Gräns').fill('4,5')
  await expect.element(screen.getByLabelText('I rad')).toHaveValue('2')
  await screen.getByRole('button', { name: m.common_save() }).click()

  await vi.waitFor(() =>
    expect(createFn).toHaveBeenCalledWith({
      kind: 'temperature',
      deviceId: DEV,
      direction: 'below',
      threshold: 4.5,
      count: 2,
    }),
  )
  await vi.waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Larmet sparat'))
  expect(onView).toHaveBeenCalledWith('list', { replace: true })
})

test.each([
  '4,3',
  'abc',
  '',
])('a temperature limit of "%s" is a field error, not a save', async (text) => {
  const { screen } = await renderForm()
  await screen.getByLabelText('Gräns').fill(text)
  await screen.getByRole('button', { name: m.common_save() }).click()
  await expect.element(screen.getByLabelText('Gräns')).toHaveAttribute('aria-invalid', 'true')
  await expect
    .element(screen.getByText(m.sensors_alert_error_temperature({ min: '−40', max: '60' })))
    .toBeVisible()
  expect(createFn).not.toHaveBeenCalled()
})

test('battery pre-fills 20 % and 2 in a row', async () => {
  const { screen } = await renderForm()
  await screen.getByRole('radio', { name: 'Batteri' }).click()
  await expect.element(screen.getByLabelText('Gräns')).toHaveValue('20')
  await expect.element(screen.getByLabelText('I rad')).toHaveValue('2')
  expect(screen.getByRole('radio', { name: 'under' }).elements()).toHaveLength(0)
  await screen.getByRole('button', { name: m.common_save() }).click()
  await vi.waitFor(() =>
    expect(createFn).toHaveBeenCalledWith({
      kind: 'battery',
      deviceId: DEV,
      threshold: 20,
      count: 2,
    }),
  )
})

test('silence pre-fills 6 hours and has no count', async () => {
  const { screen } = await renderForm()
  await screen.getByRole('radio', { name: 'Tystnad' }).click()
  await expect.element(screen.getByLabelText('Timmar utan mätning')).toHaveValue('6')
  expect(screen.getByLabelText('I rad').elements()).toHaveLength(0)
  expect(screen.getByLabelText('Gräns').elements()).toHaveLength(0)
  await screen.getByRole('button', { name: m.common_save() }).click()
  await vi.waitFor(() =>
    expect(createFn).toHaveBeenCalledWith({ kind: 'silence', deviceId: DEV, silenceHours: 6 }),
  )
})

test('a count of 1 is a field error', async () => {
  const { screen } = await renderForm()
  await screen.getByRole('radio', { name: 'Batteri' }).click()
  await screen.getByLabelText('I rad').fill('1')
  await screen.getByRole('button', { name: m.common_save() }).click()
  await expect.element(screen.getByLabelText('I rad')).toHaveAttribute('aria-invalid', 'true')
  expect(createFn).not.toHaveBeenCalled()
})

test("switching kind keeps the count and resets the limit to that kind's default", async () => {
  const { screen } = await renderForm()
  await screen.getByLabelText('Gräns').fill('7')
  await screen.getByLabelText('I rad').fill('5')
  await screen.getByRole('radio', { name: 'Batteri' }).click()
  await expect.element(screen.getByLabelText('Gräns')).toHaveValue('20')
  await expect.element(screen.getByLabelText('I rad')).toHaveValue('5')
  await screen.getByRole('radio', { name: 'Luftfuktighet' }).click()
  await expect.element(screen.getByLabelText('Gräns')).toHaveValue('')
  await expect.element(screen.getByLabelText('I rad')).toHaveValue('5')
})

test("the count hint reads the sensor's typical gap", async () => {
  const { screen } = await renderForm({ gap: 120 })
  await expect.element(screen.getByText('≈ 2–4 timmar för Förråd')).toBeVisible()
  await screen.getByLabelText('I rad').fill('3')
  await expect.element(screen.getByText('≈ 4–6 timmar för Förråd')).toBeVisible()
  // While the count isn't a valid count, no hint (never "NaN" or "0–0").
  await screen.getByLabelText('I rad').fill('')
  await expect.element(screen.getByText(/≈/)).not.toBeInTheDocument()
})

test('under an hour the hint is in minutes', async () => {
  const { screen } = await renderForm({ gap: 10 })
  await expect.element(screen.getByText('≈ 10–20 min för Förråd')).toBeVisible()
})

test('no typical gap: no hint', async () => {
  const { screen } = await renderForm({ gap: null })
  await expect.element(screen.getByLabelText('I rad')).toBeVisible()
  expect(screen.getByText(/≈/).elements()).toHaveLength(0)
})

test('editing pre-fills the rule', async () => {
  const { screen } = await renderForm({ view: HUMIDITY.id })
  await expect.element(screen.getByRole('radio', { name: 'Luftfuktighet' })).toBeChecked()
  await expect.element(screen.getByRole('radio', { name: 'över' })).toBeChecked()
  await expect.element(screen.getByLabelText('Gräns')).toHaveValue('80')
  await expect.element(screen.getByLabelText('I rad')).toHaveValue('3')
})

test('editing a half-degree limit shows it with a decimal comma and saves it', async () => {
  const { screen } = await renderForm({ view: TEMPERATURE.id })
  await expect.element(screen.getByLabelText('Gräns')).toHaveValue('4,5')
  await screen.getByLabelText('I rad').fill('4')
  await screen.getByRole('button', { name: m.common_save() }).click()
  await vi.waitFor(() =>
    expect(updateFn).toHaveBeenCalledWith({
      id: TEMPERATURE.id,
      kind: 'temperature',
      deviceId: DEV,
      direction: 'below',
      threshold: 4.5,
      count: 4,
    }),
  )
})

test('"Ta bort" asks once inline, then deletes', async () => {
  const onView = vi.fn()
  const { screen } = await renderForm({ view: HUMIDITY.id, onView })
  await screen.getByRole('button', { name: 'Ta bort' }).click()
  await expect.element(screen.getByText('Ta bort larmet?')).toBeVisible()
  expect(deleteFn).not.toHaveBeenCalled()
  await screen.getByRole('button', { name: 'Ta bort' }).click()
  await vi.waitFor(() => expect(deleteFn).toHaveBeenCalledWith({ id: HUMIDITY.id }))
  await vi.waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Larmet borttaget'))
  expect(onView).toHaveBeenCalledWith('list', { replace: true })
})

test('"Avbryt" on the delete question keeps the rule', async () => {
  const { screen } = await renderForm({ view: HUMIDITY.id })
  await screen.getByRole('button', { name: 'Ta bort' }).click()
  await screen.getByRole('button', { name: m.common_cancel() }).click()
  await expect.element(screen.getByText('Ta bort larmet?')).not.toBeInTheDocument()
  await expect.element(screen.getByRole('button', { name: m.common_save() })).toBeVisible()
  expect(deleteFn).not.toHaveBeenCalled()
})

test('a new rule has no "Ta bort"', async () => {
  const { screen } = await renderForm()
  await expect.element(screen.getByRole('button', { name: m.common_save() })).toBeVisible()
  expect(screen.getByRole('button', { name: 'Ta bort' }).elements()).toHaveLength(0)
})

test('an update of a rule that is gone toasts "Larmet finns inte längre" and returns to the list', async () => {
  updateFn.mockRejectedValue(new ORPCError('RULE_NOT_FOUND', { defined: true, status: 404 }))
  const onView = vi.fn()
  const { screen } = await renderForm({ view: HUMIDITY.id, onView })
  await screen.getByRole('button', { name: m.common_save() }).click()
  await vi.waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Larmet finns inte längre'))
  expect(onView).toHaveBeenCalledWith('list', { replace: true })
})

test('any other save failure toasts the generic error and stays in the form', async () => {
  createFn.mockRejectedValue(new Error('boom'))
  const onView = vi.fn()
  const { screen } = await renderForm({ onView })
  await screen.getByLabelText('Gräns').fill('5')
  await screen.getByRole('button', { name: m.common_save() }).click()
  await vi.waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(m.sensors_alert_save_error()))
  expect(onView).not.toHaveBeenCalled()
})

test('"Tillbaka" returns to the list without saving', async () => {
  const onView = vi.fn()
  const { screen } = await renderForm({ onView })
  await screen.getByRole('button', { name: 'Tillbaka' }).click()
  expect(onView).toHaveBeenCalledWith('list', { replace: true })
  expect(createFn).not.toHaveBeenCalled()
})

test('fixing a field error lets the rule save', async () => {
  const { screen } = await renderForm()
  await screen.getByLabelText('Gräns').fill('4,3')
  await screen.getByRole('button', { name: m.common_save() }).click()
  await expect.element(screen.getByLabelText('Gräns')).toHaveAttribute('aria-invalid', 'true')
  await screen.getByLabelText('Gräns').fill('−4,5')
  await screen.getByRole('button', { name: m.common_save() }).click()
  await vi.waitFor(() =>
    expect(createFn).toHaveBeenCalledWith(expect.objectContaining({ threshold: -4.5 })),
  )
})
