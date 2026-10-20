// Client-safe, dependency-free duration copy for alerts (ADR-0028).

/** "45 min", "2 h", "6 h 30 min", "1 d 3 h": whole minutes rounded down, zero parts left out. */
export function formatAlertDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 60_000))
  const days = Math.floor(total / 1440)
  const hours = Math.floor((total % 1440) / 60)
  const minutes = total % 60
  const parts: string[] = []
  if (days) parts.push(`${days} d`)
  if (hours) parts.push(`${hours} h`)
  if (minutes) parts.push(`${minutes} min`)
  return parts.length ? parts.join(' ') : '0 min'
}
