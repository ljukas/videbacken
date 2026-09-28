// Synthetic Zaptec API payloads for tests. Shapes follow the live API
// (verified 2026-09-28); every value is invented — never paste real probe data
// here (it carries owner email/name and session signatures).

export const TEST_CREDS = { username: 'owner@example.test', password: 'pw-SECRET-4711' }
export const TEST_TOKEN = 'tok-SECRET-abc123'
export const INSTALLATION_ID = 'inst-0001'
export const CHARGER_ID = 'chg-0001'

export function tokenBody(overrides: Record<string, unknown> = {}) {
  return { access_token: TEST_TOKEN, expires_in: 86_400, token_type: 'Bearer', ...overrides }
}

export function chargersBody(data: Record<string, unknown>[] = [chargerJson()]) {
  return { Pages: 1, TotalCount: data.length, Data: data }
}

export function chargerJson(overrides: Record<string, unknown> = {}) {
  return {
    Id: CHARGER_ID,
    Name: 'Garage',
    InstallationId: INSTALLATION_ID,
    IsOnline: true,
    DeviceType: 4,
    SerialNo: 'ZAP000000',
    ...overrides,
  }
}

/**
 * A 2.5 h session 19:30Z → 22:00Z. energyDetails: the 0-kWh start marker, then
 * hour-aligned points, the last at session end; points sum to `energy`.
 */
export function sessionJson(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess-0001',
    chargerId: CHARGER_ID,
    startDateTime: '2026-09-27T19:30:00Z',
    endDateTime: '2026-09-27T22:00:00Z',
    energy: 21.5,
    energyDetails: [
      { timestamp: '2026-09-27T19:30:00Z', energy: 0 },
      { timestamp: '2026-09-27T20:00:00Z', energy: 5.25 },
      { timestamp: '2026-09-27T21:00:00Z', energy: 10.75 },
      { timestamp: '2026-09-27T22:00:00Z', energy: 5.5 },
    ],
    authorizedUser: { id: 'user-0001', email: 'owner@example.test', fullName: 'Test Owner' },
    tokenName: null,
    voided: false,
    replacedBySessionId: null,
    offline: false,
    reliableClock: true,
    signed: false,
    sessionSignature: 'OCMF|synthetic',
    ...overrides,
  }
}

export function sessionsPage(
  sessions: Record<string, unknown>[],
  page: { cursor?: string | null; hasMore?: boolean } = {},
) {
  return { sessions, cursor: page.cursor ?? null, hasMore: page.hasMore ?? false }
}

export function stateBody(
  entries: { StateId: number; ValueAsString?: string | null; Timestamp?: string }[],
) {
  return entries
}

/** Charger state while charging at 11 kW with 3.2 kWh delivered so far. */
export function chargingStateBody() {
  return stateBody([
    { StateId: 710, ValueAsString: '3', Timestamp: '2026-09-28T10:00:00Z' },
    { StateId: 513, ValueAsString: '11.04', Timestamp: '2026-09-28T10:00:00Z' },
    { StateId: 553, ValueAsString: '3.2', Timestamp: '2026-09-28T10:00:00Z' },
    { StateId: 501, ValueAsString: '230.1' },
  ])
}
