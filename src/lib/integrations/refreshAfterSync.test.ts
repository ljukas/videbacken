import { expect, test, vi } from 'vitest'
import type { Logger } from '~/lib/logger'
import { refreshAfterSync } from './refreshAfterSync'

function fakeLog() {
  const warn = vi.fn()
  const log: Logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), child: () => log }
  return { log, warn }
}

test('nothing stored: no refresh, 0 ms', async () => {
  const refresh = vi.fn(async () => {})
  const { log } = fakeLog()
  expect(await refreshAfterSync({ stored: false, label: 'house energy month', log, refresh })).toBe(
    0,
  )
  expect(refresh).not.toHaveBeenCalled()
})

test('refreshes once and returns the whole milliseconds spent', async () => {
  const refresh = vi.fn(async () => {})
  const { log, warn } = fakeLog()
  const ms = await refreshAfterSync({ stored: true, label: 'house energy month', log, refresh })
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(Number.isInteger(ms)).toBe(true)
  expect(warn).not.toHaveBeenCalled()
})

test('a failed refresh warns and never throws', async () => {
  const error = new Error('could not refresh')
  const { log, warn } = fakeLog()
  await expect(
    refreshAfterSync({
      stored: true,
      label: 'house energy month',
      log,
      refresh: async () => Promise.reject(error),
    }),
  ).resolves.toEqual(expect.any(Number))
  expect(warn).toHaveBeenCalledWith('house energy month refresh failed', { error })
})

test('a refresh past its budget warns and returns', async () => {
  const { log, warn } = fakeLog()
  const never = () => new Promise<void>(() => {})
  await refreshAfterSync({
    stored: true,
    label: 'house energy month',
    log,
    refresh: never,
    budgetMs: 10,
  })
  expect(warn).toHaveBeenCalledWith('house energy month refresh failed', {
    error: expect.objectContaining({
      message: 'house energy month refresh did not finish within its budget',
    }),
  })
})

test('the label names the warning', async () => {
  const { log, warn } = fakeLog()
  await refreshAfterSync({
    stored: true,
    label: 'heat pump day',
    log,
    refresh: async () => Promise.reject(new Error('x')),
  })
  expect(warn).toHaveBeenCalledWith('heat pump day refresh failed', { error: expect.any(Error) })
})
