import { describe, expect, test } from 'vitest'
import { createInMemoryPresence } from './adapters/inMemory'

describe('inMemory presence adapter', () => {
  test('acquire returns true only on the offline → online transition', async () => {
    const presence = createInMemoryPresence()
    expect(await presence.acquire('alice')).toBe(true)
    expect(await presence.acquire('alice')).toBe(false)
    expect(await presence.acquire('alice')).toBe(false)
  })

  test('release returns true only when the last refcount drops to zero', async () => {
    const presence = createInMemoryPresence()
    await presence.acquire('alice')
    await presence.acquire('alice')
    await presence.acquire('alice')
    expect(await presence.release('alice')).toBe(false)
    expect(await presence.release('alice')).toBe(false)
    expect(await presence.release('alice')).toBe(true)
  })

  test('release on an unknown user is a safe no-op', async () => {
    const presence = createInMemoryPresence()
    expect(await presence.release('ghost')).toBe(false)
    expect(await presence.listOnline()).toEqual([])
  })

  test('listOnline reflects the current online set', async () => {
    const presence = createInMemoryPresence()
    expect(await presence.listOnline()).toEqual([])

    await presence.acquire('alice')
    await presence.acquire('bob')
    await presence.acquire('bob')
    expect((await presence.listOnline()).sort()).toEqual(['alice', 'bob'])

    await presence.release('alice')
    expect(await presence.listOnline()).toEqual(['bob'])

    await presence.release('bob')
    await presence.release('bob')
    expect(await presence.listOnline()).toEqual([])
  })

  test('users are tracked independently', async () => {
    const presence = createInMemoryPresence()
    expect(await presence.acquire('alice')).toBe(true)
    expect(await presence.acquire('bob')).toBe(true)
    expect(await presence.release('alice')).toBe(true)
    expect(await presence.acquire('bob')).toBe(false)
    expect(await presence.release('bob')).toBe(false)
    expect(await presence.release('bob')).toBe(true)
  })
})
