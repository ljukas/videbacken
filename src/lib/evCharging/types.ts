// The contract between the Zaptec client, the evCharging service and the sync
// run. Types only — dependency-free and client-safe.
export type ZaptecCharger = { id: string; name: string; installationId: string; isOnline: boolean }

export type ChargeInterval = { startAt: Date; endAt: Date; energyKwh: number }

export type ZaptecSession = {
  id: string
  chargerId: string
  startAt: Date
  endAt: Date
  energyKwh: number
  intervals: ChargeInterval[]
  authorizedUser: { email: string | null; name: string | null } | null
  tokenName: string | null
  voided: boolean
  replacedBySessionId: string | null
  offline: boolean
  reliableClock: boolean
}

export type LiveMode =
  | 'disconnected'
  | 'connected_requesting'
  | 'charging'
  | 'connected_finished'
  | 'unknown'

export type ZaptecLiveState = {
  mode: LiveMode
  powerKw: number | null
  sessionKwh: number | null
  observedAt: Date
}
