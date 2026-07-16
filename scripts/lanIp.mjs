// Interface-name prefixes that are never the primary LAN link: virtualization
// bridges (Docker/UTM/Parallels → bridgeN), VPN/utun tunnels, Apple Wireless
// Direct Link (awdl/llw), etc. `os.networkInterfaces()` lists these alongside
// the real Wi-Fi/Ethernet interface, so a naive "first non-internal IPv4" can
// pick the wrong one (observed: bridge100 → 192.168.64.1 for a local VM subnet).
const VIRTUAL_IFACE = /^(bridge|utun|vmnet|vnic|llw|awdl|docker|veth|tap|tun|ppp)/i

// Preferred macOS primary interfaces, in order (Wi-Fi is usually en0).
const PREFERRED = ['en0', 'en1']

/** @param {import('node:os').NetworkInterfaceInfo[] | undefined} list */
function firstExternalIpv4(list) {
  const hit = list?.find((i) => i.family === 'IPv4' && !i.internal)
  return hit?.address ?? null
}

/**
 * Best-guess primary LAN IPv4 from `os.networkInterfaces()` output, or `null`
 * when offline / nothing suitable. Prefers en0/en1 (macOS Wi-Fi/Ethernet);
 * otherwise the first non-internal IPv4 on an interface that isn't a known
 * virtual one. Pure, so it's unit-tested with fixture interface maps rather than
 * the host's live network.
 *
 * @param {NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>} interfaces
 * @returns {string | null}
 */
export function pickLanIp(interfaces) {
  for (const name of PREFERRED) {
    const addr = firstExternalIpv4(interfaces[name])
    if (addr) return addr
  }
  for (const [name, list] of Object.entries(interfaces)) {
    if (VIRTUAL_IFACE.test(name)) continue
    const addr = firstExternalIpv4(list)
    if (addr) return addr
  }
  return null
}
