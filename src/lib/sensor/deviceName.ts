// Client-safe sensor naming, shared by the service (the displayName it returns)
// and the edit dialog (placeholder, helper, badge). No server imports.

/** The name a sensor shows without an admin-set name: its Shelly app name, else "Sensor" + the MAC's last four. */
export function fallbackSensorName(shellyName: string | null, mac: string): string {
  return shellyName ?? `Sensor ${mac.slice(-4)}`
}

/** Own name → Shelly name → "Sensor a1b2". */
export function sensorDisplayName(
  name: string | null,
  shellyName: string | null,
  mac: string,
): string {
  return name ?? fallbackSensorName(shellyName, mac)
}

/** A stored (normalized, 12-hex) MAC as the Shelly app shows it: `AA:BB:CC:DD:EE:FF`. */
export function formatMac(mac: string): string {
  const upper = mac.toUpperCase()
  return /^[0-9A-F]{12}$/.test(upper) ? (upper.match(/../g) ?? []).join(':') : upper
}
