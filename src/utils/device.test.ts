import { describe, expect, it } from 'vitest'
import { isIOSUserAgent } from './device'

// Representative UA strings (verified against bowser 2.14.1). The contract that
// matters: iPhones/iPods (any browser — they all carry the device token) read as
// iOS, while real desktops and Android never do. The modern-iPad case is a
// documented, intentional miss — see `isIOSUserAgent`.
const UA = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1',
  ipadOldUa:
    'Mozilla/5.0 (iPad; CPU OS 16_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.3 Mobile/15E148 Safari/604.1',
  // Modern iPadOS ("Request Desktop Website", the default) is byte-identical to a
  // desktop Mac UA — no pure-UA parser can tell them apart.
  ipadMacUa:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  desktopMacSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
  windowsChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
}

describe('isIOSUserAgent', () => {
  it('is true for iPhone (any browser) and old-UA iPads', () => {
    expect(isIOSUserAgent(UA.iphoneSafari)).toBe(true)
    expect(isIOSUserAgent(UA.iphoneChrome)).toBe(true)
    expect(isIOSUserAgent(UA.ipadOldUa)).toBe(true)
  })

  it('is false for desktops and Android (no false positives — the dangerous direction)', () => {
    expect(isIOSUserAgent(UA.desktopMacSafari)).toBe(false)
    expect(isIOSUserAgent(UA.androidChrome)).toBe(false)
    expect(isIOSUserAgent(UA.windowsChrome)).toBe(false)
  })

  it('treats a modern iPad (Macintosh UA) as non-iOS — a documented safe no-op', () => {
    expect(isIOSUserAgent(UA.ipadMacUa)).toBe(false)
  })

  it('is false for an empty user agent (SSR / unknown)', () => {
    expect(isIOSUserAgent('')).toBe(false)
  })
})
