import { millisecondsInDay, millisecondsInHour } from 'date-fns/constants'
import type { ChargeInterval, ZaptecSession } from '~/lib/evCharging/types'
import type { ZaptecClient } from '../zaptec'

// Synthetic Zaptec data for local UI work (`ZAPTEC_ADAPTER=fake`). One
// charger; one overnight session per day (22:00Z → 01:00Z, ~11 kW) with a
// deterministic per-day energy so repeated syncs import identical rows.

const CHARGER = {
  id: 'fake-charger-1',
  name: 'Laddbox (fake)',
  installationId: 'fake-installation-1',
  isOnline: true,
}

function sessionForDay(dayStartMs: number): ZaptecSession {
  const start = dayStartMs + 22 * millisecondsInHour
  const day = Math.floor(dayStartMs / millisecondsInDay)
  const lastHourKwh = 2 + (day % 7) // 2–8 kWh in the final hour
  const perHour = [10.8, 10.8, lastHourKwh]
  const intervals: ChargeInterval[] = perHour.map((energyKwh, i) => ({
    startAt: new Date(start + i * millisecondsInHour),
    endAt: new Date(start + (i + 1) * millisecondsInHour),
    energyKwh,
  }))
  return {
    id: `fake-session-${day}`,
    chargerId: CHARGER.id,
    startAt: new Date(start),
    endAt: new Date(start + perHour.length * millisecondsInHour),
    energyKwh: perHour.reduce((a, b) => a + b, 0),
    intervals,
    authorizedUser: { email: null, name: 'Fake Owner' },
    tokenName: null,
    voided: false,
    replacedBySessionId: null,
    offline: false,
    reliableClock: true,
  }
}

export const fake: ZaptecClient = {
  async chargers() {
    return [CHARGER]
  },
  async *sessionsEndedSince(since, o) {
    const until = (o.until ?? new Date()).getTime()
    const sessions: ZaptecSession[] = []
    // Start a day early: a session starting the evening before `since` may end after it.
    const firstDay = Math.floor(since.getTime() / millisecondsInDay) - 1
    for (let day = firstDay; day * millisecondsInDay < until; day++) {
      const s = sessionForDay(day * millisecondsInDay)
      if (s.endAt.getTime() >= since.getTime() && s.endAt.getTime() < until) sessions.push(s)
    }
    if (o.stats) o.stats.pages++
    yield sessions
  },
  async liveState() {
    const now = new Date()
    const hour = now.getUTCHours()
    const charging = hour >= 22 || hour < 1
    return {
      mode: charging ? 'charging' : 'connected_finished',
      powerKw: charging ? 10.8 : 0,
      sessionKwh: charging ? ((hour + 2) % 24) * 10.8 : null,
      observedAt: now,
    }
  },
}
