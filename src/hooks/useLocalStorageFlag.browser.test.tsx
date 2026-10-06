import { afterEach, expect, test, vi } from 'vitest'
import { renderWithProviders } from '~test/browser/render'
import { useLocalStorageFlag } from './useLocalStorageFlag'

const KEY = 'videbacken-test-flag'

function Probe() {
  const [on, set] = useLocalStorageFlag(KEY, true)
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
