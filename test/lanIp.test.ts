import type { NetworkInterfaceInfo } from 'node:os'
import { describe, expect, it } from 'vitest'
// Launcher-only helper — plain .mjs like the other scripts/, so it's imported
// from here (scripts/ isn't in the vitest include) rather than colocated.
import { pickLanIp } from '../scripts/lanIp.mjs'

// Minimal fixture entries — only the fields pickLanIp reads.
const v4 = (address: string, internal = false): NetworkInterfaceInfo =>
  ({ address, family: 'IPv4', internal }) as NetworkInterfaceInfo
const v6 = (): NetworkInterfaceInfo => ({ family: 'IPv6', internal: false }) as NetworkInterfaceInfo

describe('pickLanIp', () => {
  it('prefers en0 even when a virtual bridge is also present', () => {
    expect(
      pickLanIp({
        lo0: [v4('127.0.0.1', true)],
        en0: [v6(), v4('192.168.68.130')],
        bridge100: [v4('192.168.64.1')],
      }),
    ).toBe('192.168.68.130')
  })

  it('falls back to en1 when en0 has no external IPv4', () => {
    expect(pickLanIp({ en0: [v6()], en1: [v4('10.0.0.5')] })).toBe('10.0.0.5')
  })

  it('never picks a virtual interface (bridge only → null)', () => {
    expect(pickLanIp({ lo0: [v4('127.0.0.1', true)], bridge100: [v4('192.168.64.1')] })).toBeNull()
  })

  it('uses a non-en real interface when no en0/en1 (e.g. Linux eth0)', () => {
    expect(pickLanIp({ eth0: [v4('192.168.1.20')], docker0: [v4('172.17.0.1')] })).toBe(
      '192.168.1.20',
    )
  })

  it('returns null when only loopback / nothing external', () => {
    expect(pickLanIp({ lo0: [v4('127.0.0.1', true)] })).toBeNull()
    expect(pickLanIp({})).toBeNull()
  })
})
