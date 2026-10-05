import { afterEach, describe, expect, it, vi } from 'vitest'
import { cachedStored, invalidateCredentials, STORED_TTL_MS } from './cache'

afterEach(() => invalidateCredentials())

describe('stored-credential cache', () => {
  it('shares one in-flight load between callers', async () => {
    let resolve: (v: string) => void = () => {}
    const load = vi.fn(() => new Promise<string>((r) => (resolve = r)))
    const a = cachedStored('skoda', load, 0)
    const b = cachedStored('skoda', load, 1)
    resolve('value')
    expect(await a).toBe('value')
    expect(await b).toBe('value')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('reuses a value before the TTL and reloads after it', async () => {
    const load = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second')
    expect(await cachedStored('zaptec', load, 1_000)).toBe('first')
    expect(await cachedStored('zaptec', load, 1_000 + STORED_TTL_MS - 1)).toBe('first')
    expect(load).toHaveBeenCalledTimes(1)
    expect(await cachedStored('zaptec', load, 1_000 + STORED_TTL_MS)).toBe('second')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('does not cache a rejected load', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('ok')
    await expect(cachedStored('emaldo', load, 0)).rejects.toThrow('boom')
    expect(await cachedStored('emaldo', load, 1)).toBe('ok')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('turns a synchronous throw into a rejection and does not cache it', async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => {
        throw new Error('sync')
      })
      .mockResolvedValueOnce('ok')
    await expect(cachedStored('emaldo', load, 0)).rejects.toThrow('sync')
    expect(await cachedStored('emaldo', load, 1)).toBe('ok')
  })

  it('invalidates one source, or every source with no argument', async () => {
    const skoda = vi.fn().mockResolvedValue('s')
    const zaptec = vi.fn().mockResolvedValue('z')
    await cachedStored('skoda', skoda, 0)
    await cachedStored('zaptec', zaptec, 0)

    invalidateCredentials('skoda')
    await cachedStored('skoda', skoda, 1)
    await cachedStored('zaptec', zaptec, 1)
    expect(skoda).toHaveBeenCalledTimes(2)
    expect(zaptec).toHaveBeenCalledTimes(1)

    invalidateCredentials()
    await cachedStored('skoda', skoda, 2)
    await cachedStored('zaptec', zaptec, 2)
    expect(skoda).toHaveBeenCalledTimes(3)
    expect(zaptec).toHaveBeenCalledTimes(2)
  })

  it('an in-flight load invalidated mid-flight is not cached when it settles', async () => {
    let resolve: (v: string) => void = () => {}
    const stale = vi.fn(() => new Promise<string>((r) => (resolve = r)))
    const fresh = vi.fn().mockResolvedValue('fresh')
    const first = cachedStored('gridTariff', stale, 0)
    invalidateCredentials('gridTariff')
    resolve('stale')
    expect(await first).toBe('stale')
    expect(await cachedStored('gridTariff', fresh, 1)).toBe('fresh')
  })
})
