import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { renderWithProviders } from '~test/browser/render'
import { useAwaitSignIn } from './useAwaitSignIn'

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }))
vi.mock('~/lib/getSession', () => ({ getSession }))

const SESSION = { user: { id: 'u1' }, session: { id: 's1' } }

let visibility: DocumentVisibilityState = 'visible'
function setVisibility(state: DocumentVisibilityState) {
  visibility = state
  // Real browsers fire it on the document and it bubbles to the window.
  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
}

function Harness({ enabled, onSignedIn }: { enabled: boolean; onSignedIn: () => void }) {
  useAwaitSignIn({ enabled, onSignedIn })
  return null
}

// The app's own defaults (a 20 s staleTime) — the hook must not depend on them.
const appLikeClient = () =>
  new QueryClient({ defaultOptions: { queries: { staleTime: 20_000, gcTime: Infinity } } })

async function mount(enabled = true) {
  const onSignedIn = vi.fn()
  const { screen } = await renderWithProviders(
    <Harness enabled={enabled} onSignedIn={onSignedIn} />,
    { queryClient: appLikeClient() },
  )
  await vi.advanceTimersByTimeAsync(0)
  return { onSignedIn, screen }
}

beforeEach(() => {
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  getSession.mockReset()
  getSession.mockResolvedValue(null)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
})

afterEach(() => {
  vi.useRealTimers()
  // Drop the override so the real getter shows through again.
  Reflect.deleteProperty(document, 'visibilityState')
})

test('does nothing while disabled', async () => {
  await mount(false)
  await vi.advanceTimersByTimeAsync(10_000)
  setVisibility('visible')
  await vi.advanceTimersByTimeAsync(0)
  expect(getSession).not.toHaveBeenCalled()
})

test('checks at once, then every 2.5 s while no session', async () => {
  await mount()
  expect(getSession).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(2_499)
  expect(getSession).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(getSession).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(2_500)
  expect(getSession).toHaveBeenCalledTimes(3)
})

test('skips polls while hidden and re-checks at once when visible again', async () => {
  await mount()
  setVisibility('hidden')
  await vi.advanceTimersByTimeAsync(10_000)
  expect(getSession).toHaveBeenCalledTimes(1)
  setVisibility('visible')
  await vi.advanceTimersByTimeAsync(0)
  expect(getSession).toHaveBeenCalledTimes(2)
})

test('never overlaps checks while one is in flight', async () => {
  let resolve: (v: null) => void = () => {}
  getSession.mockImplementationOnce(() => new Promise((r) => (resolve = r)))
  await mount()
  await vi.advanceTimersByTimeAsync(7_500)
  setVisibility('visible')
  await vi.advanceTimersByTimeAsync(0)
  expect(getSession).toHaveBeenCalledTimes(1)
  resolve(null)
  await vi.advanceTimersByTimeAsync(2_500)
  expect(getSession).toHaveBeenCalledTimes(2)
})

test('calls onSignedIn once when a session appears, then stops checking', async () => {
  const { onSignedIn } = await mount()
  getSession.mockResolvedValue(SESSION)
  await vi.advanceTimersByTimeAsync(2_500)
  expect(onSignedIn).toHaveBeenCalledOnce()
  const calls = getSession.mock.calls.length
  await vi.advanceTimersByTimeAsync(10_000)
  setVisibility('hidden')
  setVisibility('visible')
  await vi.advanceTimersByTimeAsync(0)
  expect(getSession).toHaveBeenCalledTimes(calls)
  expect(onSignedIn).toHaveBeenCalledOnce()
})

test('stops checking on unmount', async () => {
  const { screen } = await mount()
  await screen.unmount()
  await vi.advanceTimersByTimeAsync(10_000)
  setVisibility('visible')
  await vi.advanceTimersByTimeAsync(0)
  expect(getSession).toHaveBeenCalledTimes(1)
})
