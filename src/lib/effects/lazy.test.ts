import { expect, test, vi } from 'vitest'
import { lazy } from './lazy'

test('runs the factory once and reuses the resolved value across calls', async () => {
  const factory = vi.fn(async () => ({ id: 'adapter' }))
  const get = lazy(factory)

  const a = await get()
  const b = await get()
  const c = await get()

  expect(factory).toHaveBeenCalledTimes(1)
  expect(a).toBe(b)
  expect(b).toBe(c)
})

test('concurrent callers before the first resolve share one in-flight promise', async () => {
  let resolved = 0
  const factory = vi.fn(async () => {
    resolved += 1
    return resolved
  })
  const get = lazy(factory)

  const [first, second] = await Promise.all([get(), get()])

  expect(factory).toHaveBeenCalledTimes(1)
  expect(first).toBe(1)
  expect(second).toBe(1)
})
