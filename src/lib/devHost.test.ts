import { afterEach, describe, expect, it } from 'vitest'
import { devBaseUrl, devS3Endpoint, devTrustedOrigins } from './devHost'

afterEach(() => {
  delete process.env.DEV_HOST
})

describe('devHost getters', () => {
  it('return null / [] when DEV_HOST is unset (plain `pnpm dev`, prod)', () => {
    delete process.env.DEV_HOST
    expect(devBaseUrl()).toBeNull()
    expect(devS3Endpoint()).toBeNull()
    expect(devTrustedOrigins()).toEqual([])
  })

  it('build LAN URLs from DEV_HOST when set (`pnpm dev --host`)', () => {
    process.env.DEV_HOST = '192.168.68.130'
    expect(devBaseUrl()).toBe('http://192.168.68.130:14500')
    expect(devS3Endpoint()).toBe('http://192.168.68.130:14523')
  })

  it('trust localhost AND the LAN IP together, so both browsers work at once', () => {
    process.env.DEV_HOST = '192.168.68.130'
    expect(devTrustedOrigins()).toEqual([
      'http://localhost:14500',
      'http://127.0.0.1:14500',
      'http://192.168.68.130:14500',
    ])
  })
})
