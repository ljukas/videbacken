import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { renderWithProviders } from '~test/browser/render'
import { useLocalStorageFlag } from './useLocalStorageFlag'

// A unique key per test: the hook's in-memory fallback is module-level and would otherwise leak between tests.
let n = 0
let KEY = ''
beforeEach(() => {
  KEY = `videbacken-test-flag-${n++}`
})

function Probe({ k = KEY }: { k?: string }) {
  const [on, set] = useLocalStorageFlag(k, true)
  return (
    <button type="button" onClick={() => set(!on)}>
      {on ? 'on' : 'off'}
    </button>
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  try {
    localStorage.removeItem(KEY)
  } catch {}
})

test('starts at the fallback and remembers a change', async () => {
  const { screen } = await renderWithProviders(<Probe />)
  await expect.element(screen.getByRole('button', { name: 'on' })).toBeVisible()
  await screen.getByRole('button').click()
  await expect.element(screen.getByRole('button', { name: 'off' })).toBeVisible()
  expect(localStorage.getItem(KEY)).toBe('0')
})

test('reads a stored value', async () => {
  localStorage.setItem(KEY, '0')
  const { screen } = await renderWithProviders(<Probe />)
  await expect.element(screen.getByRole('button', { name: 'off' })).toBeVisible()
})

test('still toggles for the session when storage throws', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  const { screen } = await renderWithProviders(<Probe />)
  await expect.element(screen.getByRole('button', { name: 'on' })).toBeVisible()
  await screen.getByRole('button').click()
  await expect.element(screen.getByRole('button', { name: 'off' })).toBeVisible()
})

test('keeps the switch working when a write fails over a stored value', async () => {
  localStorage.setItem(KEY, '1')
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('quota')
  })
  const { screen } = await renderWithProviders(<Probe />)
  await expect.element(screen.getByRole('button', { name: 'on' })).toBeVisible()
  await screen.getByRole('button').click()
  await expect.element(screen.getByRole('button', { name: 'off' })).toBeVisible()
  await screen.getByRole('button').click()
  await expect.element(screen.getByRole('button', { name: 'on' })).toBeVisible()
})

test('two components on one key stay in sync', async () => {
  const { screen } = await renderWithProviders(
    <>
      <Probe />
      <Probe />
    </>,
  )
  await expect.element(screen.getByRole('button', { name: 'on' }).first()).toBeVisible()
  await screen.getByRole('button').first().click()
  await expect.element(screen.getByRole('button', { name: 'off' }).first()).toBeVisible()
  await expect.element(screen.getByRole('button', { name: 'off' }).last()).toBeVisible()
})

test('follows another tab: same key, a cleared storage; ignores other keys', async () => {
  const { screen } = await renderWithProviders(<Probe />)
  await expect.element(screen.getByRole('button', { name: 'on' })).toBeVisible()
  localStorage.setItem(KEY, '0')
  window.dispatchEvent(new StorageEvent('storage', { key: `${KEY}-other` }))
  await expect.element(screen.getByRole('button', { name: 'on' })).toBeVisible()
  window.dispatchEvent(new StorageEvent('storage', { key: KEY }))
  await expect.element(screen.getByRole('button', { name: 'off' })).toBeVisible()
  localStorage.removeItem(KEY)
  window.dispatchEvent(new StorageEvent('storage', { key: null }))
  await expect.element(screen.getByRole('button', { name: 'on' })).toBeVisible()
})
