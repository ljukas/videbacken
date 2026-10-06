import { expect, test, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { useIdlePreload } from './useIdlePreload'

function Harness({
  enabled,
  loaders,
}: {
  enabled: boolean
  loaders: ReadonlyArray<() => Promise<unknown>>
}) {
  useIdlePreload(enabled, loaders)
  return null
}

const idle = () => new Promise<void>((resolve) => requestIdleCallback(() => resolve()))

test('enabled: each loader is called exactly once after idle', async () => {
  const a = vi.fn(() => Promise.resolve())
  const b = vi.fn(() => Promise.resolve())
  const loaders = [a, b]
  const screen = await render(<Harness enabled loaders={loaders} />)
  await expect.poll(() => a.mock.calls.length).toBe(1)
  expect(b).toHaveBeenCalledTimes(1)
  await screen.rerender(<Harness enabled loaders={loaders} />)
  await idle()
  expect(a).toHaveBeenCalledTimes(1)
  expect(b).toHaveBeenCalledTimes(1)
})

test('disabled: no loader is ever called', async () => {
  const a = vi.fn(() => Promise.resolve())
  await render(<Harness enabled={false} loaders={[a]} />)
  await idle()
  await idle()
  expect(a).not.toHaveBeenCalled()
})

test('unmount before idle: the scheduled callback is cancelled and no loader is called', async () => {
  const request = vi.fn((_cb: IdleRequestCallback) => 42)
  const cancel = vi.fn()
  vi.stubGlobal('requestIdleCallback', request)
  vi.stubGlobal('cancelIdleCallback', cancel)
  try {
    const a = vi.fn(() => Promise.resolve())
    const screen = await render(<Harness enabled loaders={[a]} />)
    expect(request).toHaveBeenCalledTimes(1)
    await screen.unmount()
    expect(cancel).toHaveBeenCalledWith(42)
    expect(a).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllGlobals()
  }
})

test('a rejecting loader produces no unhandled rejection', async () => {
  const unhandled = vi.fn()
  window.addEventListener('unhandledrejection', unhandled)
  try {
    const bad = vi.fn(() => Promise.reject(new Error('chunk failed')))
    await render(<Harness enabled loaders={[bad]} />)
    await expect.poll(() => bad.mock.calls.length).toBe(1)
    await idle()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(unhandled).not.toHaveBeenCalled()
  } finally {
    window.removeEventListener('unhandledrejection', unhandled)
  }
})
