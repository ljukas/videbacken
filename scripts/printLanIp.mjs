import { networkInterfaces } from 'node:os'
import { pickLanIp } from './lanIp.mjs'

// Prints the machine's primary LAN IPv4 to stdout (nothing if none), for the
// `dev:host` script: `DEV_HOST=$(node scripts/printLanIp.mjs) vite dev --host`.
// Hints go to stderr so they don't pollute the captured stdout value. When no IP
// is found, stdout is empty → DEV_HOST="" → the app falls back to localhost
// (see src/lib/devHost.ts) and Vite still binds 0.0.0.0.

const ip = pickLanIp(networkInterfaces())

if (ip) {
  process.stderr.write(
    `\n  ▸ LAN host mode — on your phone (same Wi-Fi):\n` +
      `      Mailpit (tap the sign-in link): http://${ip}:14502\n` +
      `      (the app URL is Vite's "Network" line below)\n\n`,
  )
  process.stdout.write(ip)
} else {
  process.stderr.write('\n  ⚠  No LAN IPv4 found (offline?). DEV_HOST unset — localhost only.\n\n')
}
