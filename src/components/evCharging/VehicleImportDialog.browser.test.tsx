import { ORPCError } from '@orpc/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { MAX_IMPORT_ROWS } from '~/lib/evCharging/vehicle'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { SKODA_EXPORT_FIXTURE } from '~test/fixtures/skodaExport'
import { VehicleImportDialog } from './VehicleImportDialog'

const { importFn, toastMock } = vi.hoisted(() => ({
  importFn: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn() },
}))
vi.mock('~/lib/orpc/client', () => ({
  orpc: {
    evCharging: {
      importVehicleRecords: {
        mutationOptions: (opts: Record<string, unknown>) => ({ ...opts, mutationFn: importFn }),
      },
      key: () => ['evCharging'],
    },
  },
}))
vi.mock('sonner', () => ({ toast: toastMock }))

afterEach(() => {
  vi.restoreAllMocks()
})

beforeEach(() => {
  importFn.mockReset()
  toastMock.success.mockReset()
  toastMock.error.mockReset()
})

const fixture = () => new File([SKODA_EXPORT_FIXTURE], 'export.csv', { type: 'text/csv' })
const importButton = (screen: Awaited<ReturnType<typeof renderWithProviders>>['screen']) =>
  screen.getByRole('button', { name: m.charging_vehicle_import_button() })

async function setup(onOpenChange = () => {}) {
  const view = await renderWithProviders(<VehicleImportDialog open onOpenChange={onOpenChange} />)
  return { ...view, fileInput: view.screen.getByLabelText(m.charging_vehicle_import_file()) }
}

test('previews the export and imports only the parsed rows', async () => {
  importFn.mockResolvedValue({ inserted: 3, unchanged: 0, ours: 2, other: 1 })
  const onOpenChange = vi.fn()
  const { screen, fileInput } = await setup(onOpenChange)
  await userEvent.upload(fileInput, fixture())
  await expect.element(screen.getByText(/3 laddningar/)).toBeVisible()
  await expect
    .element(screen.getByText(m.charging_vehicle_import_dropped({ count: 1 })))
    .toBeVisible()
  await importButton(screen).click()
  await vi.waitFor(() => expect(importFn).toHaveBeenCalled())
  const sent = importFn.mock.calls[0][0].rows
  expect(sent).toHaveLength(3)
  expect(JSON.stringify(importFn.mock.calls[0][0])).not.toContain('Testgatan')
  expect(toastMock.success).toHaveBeenCalledWith(
    m.charging_vehicle_import_done({ ours: 2, other: 1 }),
  )
  expect(onOpenChange).toHaveBeenCalledWith(false)
})

test('re-importing an already imported log still reports a real outcome', async () => {
  importFn.mockResolvedValue({ inserted: 0, unchanged: 3, ours: 2, other: 1 })
  const { screen, fileInput } = await setup()
  await userEvent.upload(fileInput, fixture())
  await expect.element(screen.getByText(/3 laddningar/)).toBeVisible()
  await importButton(screen).click()
  await vi.waitFor(() =>
    expect(toastMock.success).toHaveBeenCalledWith(
      m.charging_vehicle_import_done({ ours: 2, other: 1 }),
    ),
  )
})

test('a wrong file shows an error and cannot be imported', async () => {
  const { screen, fileInput } = await setup()
  await userEvent.upload(fileInput, new File(['a,b\n1,2\n'], 'x.csv'))
  await expect.element(screen.getByText(m.charging_vehicle_import_wrong_file())).toBeVisible()
  await importButton(screen).click()
  expect(importFn).not.toHaveBeenCalled()
})

test('an export without charges says so, distinct from a wrong file', async () => {
  const header = SKODA_EXPORT_FIXTURE.split('\r\n')[0]
  const { screen, fileInput } = await setup()
  await userEvent.upload(fileInput, new File([`${header}\r\n`], 'empty.csv'))
  await expect.element(screen.getByText(m.charging_vehicle_import_empty())).toBeVisible()
  await importButton(screen).click()
  expect(importFn).not.toHaveBeenCalled()
})

test('submitting without a file asks for one', async () => {
  const { screen } = await setup()
  await importButton(screen).click()
  await expect.element(screen.getByText(m.charging_vehicle_import_choose())).toBeVisible()
  expect(importFn).not.toHaveBeenCalled()
})

test('a file over the server row limit is refused locally', async () => {
  const lines = SKODA_EXPORT_FIXTURE.split('\r\n')
  const row = lines[1]
  const many = [
    lines[0],
    ...Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => row.replace('"s-1"', `"big-${i}"`)),
  ].join('\r\n')
  const { screen, fileInput } = await setup()
  await userEvent.upload(fileInput, new File([many], 'big.csv'))
  await expect
    .element(screen.getByText(m.charging_vehicle_import_too_many({ max: MAX_IMPORT_ROWS })))
    .toBeVisible()
  await importButton(screen).click()
  expect(importFn).not.toHaveBeenCalled()
})

test('a failed import is a toast, keeps the dialog open and is not the wrong-file message', async () => {
  importFn.mockRejectedValue(new ORPCError('INTERNAL_SERVER_ERROR'))
  const onOpenChange = vi.fn()
  const { screen, fileInput } = await setup(onOpenChange)
  await userEvent.upload(fileInput, fixture())
  await expect.element(screen.getByText(/3 laddningar/)).toBeVisible()
  await importButton(screen).click()
  await vi.waitFor(() =>
    expect(toastMock.error).toHaveBeenCalledWith(m.charging_vehicle_import_error()),
  )
  expect(toastMock.success).not.toHaveBeenCalled()
  expect(onOpenChange).not.toHaveBeenCalledWith(false)
})

test('a slow first pick cannot overwrite a second one: preview and rows are the second file', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => {
    release = r
  })
  const realText = File.prototype.text
  let slowRead: Promise<string> = Promise.resolve('')
  vi.spyOn(File.prototype, 'text').mockImplementation(function (this: File) {
    if (this.name !== 'slow.csv') return realText.call(this)
    slowRead = gate.then(() => realText.call(this))
    return slowRead
  })
  importFn.mockResolvedValue({ inserted: 1, unchanged: 0, ours: 1, other: 0 })
  const lines = SKODA_EXPORT_FIXTURE.split('\r\n')
  const single = `${lines[0]}\r\n${lines[1]}\r\n`
  const { screen, fileInput } = await setup()
  await userEvent.upload(fileInput, new File([SKODA_EXPORT_FIXTURE], 'slow.csv'))
  // While the first is still being read, nothing is submittable.
  await expect.element(screen.getByText(m.charging_vehicle_import_reading())).toBeVisible()
  await userEvent.upload(fileInput, new File([single], 'fast.csv'))
  await expect.element(screen.getByText(/1 laddning ·/)).toBeVisible()
  release()
  // The slow read finishes after the newer pick; a frame lets its continuation run.
  await slowRead
  await new Promise((r) => requestAnimationFrame(() => r(undefined)))
  await expect.element(screen.getByText(/1 laddning ·/)).toBeVisible()
  await importButton(screen).click()
  await vi.waitFor(() => expect(importFn).toHaveBeenCalled())
  expect(importFn.mock.calls[0][0].rows).toHaveLength(1)
})

test('submitting while a file is still being read sends nothing', async () => {
  const gate = new Promise<void>(() => {})
  const realText = File.prototype.text
  vi.spyOn(File.prototype, 'text').mockImplementation(async function (this: File) {
    await gate
    return realText.call(this)
  })
  const { screen, fileInput } = await setup()
  await userEvent.upload(fileInput, fixture())
  await importButton(screen).click()
  expect(importFn).not.toHaveBeenCalled()
})

test('a file over the size cap is refused without being read', async () => {
  const text = vi.spyOn(File.prototype, 'text')
  const { screen, fileInput } = await setup()
  await userEvent.upload(fileInput, new File(['x'.repeat(5 * 1024 * 1024 + 1)], 'huge.csv'))
  await expect.element(screen.getByText(m.charging_vehicle_import_too_big())).toBeVisible()
  expect(text).not.toHaveBeenCalled()
})

test('the dialog cannot be closed while the import is in flight', async () => {
  let finish: (v: unknown) => void = () => {}
  importFn.mockReturnValue(new Promise((r) => (finish = r)))
  const onOpenChange = vi.fn()
  const { screen, fileInput } = await setup(onOpenChange)
  await userEvent.upload(fileInput, fixture())
  await expect.element(screen.getByText(/3 laddningar/)).toBeVisible()
  await importButton(screen).click()
  await vi.waitFor(() => expect(importFn).toHaveBeenCalled())
  await userEvent.keyboard('{Escape}')
  expect(onOpenChange).not.toHaveBeenCalled()
  finish({ inserted: 3, unchanged: 0, ours: 2, other: 1 })
  await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
})

test('the preview is a polite status the file input points at', async () => {
  const { screen, fileInput } = await setup()
  await userEvent.upload(fileInput, fixture())
  await expect.element(screen.getByRole('status')).toHaveTextContent(/3 laddningar/)
  await expect.element(fileInput).toHaveAttribute('aria-describedby', 'vehicleExport-status')
})
