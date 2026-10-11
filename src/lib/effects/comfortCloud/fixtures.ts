// Synthetic Comfort Cloud test data — never real readings, guids, accounts or tokens (the repo
// is public). The shapes follow the 2026-10-08 probe: the Auth0 statuses, Set-Cookie names and
// hidden inputs, and the JSON keys of every answer. Every value is made up.
import { type FakeRoute, jsonResponse } from '../testing/fakeFetch'
import { AUTH_BASE, REDIRECT_URI } from './constants'

export const TEST_USER = 'owner@example.test'
export const TEST_PASSWORD = 'not-a-real-password'
export const TEST_ACCESS_TOKEN = 'test-access-token-0001'
export const TEST_ACCESS_TOKEN_2 = 'test-access-token-0002'
export const TEST_REFRESH_TOKEN = 'test-refresh-token-0001'
export const TEST_ID_TOKEN = 'test-id-token-0001'
export const TEST_CODE = 'test-authorization-code-0001'
export const TEST_CSRF = 'test-csrf-0001'
export const TEST_AUTH0_STATE = 'test-auth0-state-0001'
export const TEST_WRESULT = 'test-wresult-0001'
export const TEST_MFA_TOKEN = 'test-mfa-token-0001'
export const TEST_GUARDIAN_TOKEN = 'test-guardian-request-token-0001'
export const TEST_CLIENT_ID = 'test-client-id-0001'
export const TEST_EXT_USER_ID = 'test-ext-user-id-0001'
export const MATSAL_GUID = 'CS-HZ25ZKE+0000000001'
export const OVERVANING_GUID = 'CS-HZ25ZKE+0000000002'
export const AQUAREA_GUID = 'WH-TEST0000+0000000003'
export const MODEL = 'CS-HZ25ZKE'
export const NO = -255

/** fakeFetch route keys (pathname only; the three hosts share no path). */
export const ROUTES = {
  authorize: 'GET /authorize',
  loginPage: 'GET /login',
  password: 'POST /usernamepassword/login',
  callback: 'POST /login/callback',
  resume: 'GET /authorize/resume',
  token: 'POST /oauth/token',
  accLogin: 'POST /auth/v2/login',
  group: 'GET /device/group',
  history: 'POST /deviceHistoryData',
  playStore: 'GET /store/apps/details',
} as const

const cookie = (name: string, value: string, path = '/') =>
  `${name}=${value}; Path=${path}; Secure; HttpOnly; SameSite=None`

function withCookies(
  status: number,
  body: string,
  headers: Record<string, string>,
  cookies: string[],
): Response {
  const h = new Headers(headers)
  for (const c of cookies) h.append('set-cookie', c)
  return new Response(body, { status, headers: h })
}

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })

export const authorizeRedirect = (
  location = `/login?state=${TEST_AUTH0_STATE}&client=test-client&protocol=oauth2`,
) =>
  withCookies(302, 'Found', { location, 'content-type': 'text/plain; charset=utf-8' }, [
    cookie('auth0', 'test-auth0-cookie'),
    cookie('auth0_compat', 'test-auth0-cookie'),
    cookie('did', 'test-did'),
    cookie('did_compat', 'test-did'),
  ])

export const loginPage = () =>
  withCookies(
    200,
    '<!DOCTYPE html><html><head><title>Sign in</title></head><body><div id="app"></div></body></html>',
    { 'content-type': 'text/html; charset=utf-8' },
    [cookie('_csrf', TEST_CSRF, '/usernamepassword/login')],
  )

/** The password POST's answer: the auto-submitting WS-Fed callback form. */
export const callbackForm = () =>
  html(`<html><head><title>Submit This Form</title></head><body>
<form method="post" name="hiddenform" action="${AUTH_BASE}/login/callback">
<input type="hidden" name="wa" value="wsignin1.0">
<input type="hidden" name="wresult" value="${TEST_WRESULT}&amp;sig">
<input type="hidden" name="wctx" value="{&#34;strategy&#34;:&#34;auth0&#34;,&#34;state&#34;:&#34;${TEST_AUTH0_STATE}&#34;}">
<noscript><p>Script is disabled. Click Submit to continue.</p><input type="submit" value="Submit"></noscript>
</form><script>window.setTimeout(function(){document.forms[0].submit()},0)</script></body></html>`)

/** Classic Universal Login MFA prompt. */
export const mfaTokenForm = () =>
  html(`<html><body><form method="post"><input type="hidden" name="mfa_token" value="${TEST_MFA_TOKEN}">
<input type="hidden" name="state" value="${TEST_AUTH0_STATE}"></form></body></html>`)

/** Auth0 Guardian's hosted widget ("MFA Standard"): an inline JS object, not JSON. */
export const guardianPage = () =>
  html(`<html><body><script>window.__g_config = {
  postActionURL: "${AUTH_BASE}/continue?state=${TEST_AUTH0_STATE}",
  serviceUrl: "https://mfa.example.test", // comment
  requestToken: "${TEST_GUARDIAN_TOKEN}",
  stateCheckingMechanism: "polling"
};</script></body></html>`)

export const callbackRedirect = () =>
  withCookies(302, 'Found', { location: `/authorize/resume?state=${TEST_AUTH0_STATE}` }, [
    cookie('auth0', 'test-auth0-callback'),
    cookie('auth0_compat', 'test-auth0-callback'),
  ])

export const resumeRedirect = (location = `${REDIRECT_URI}?code=${TEST_CODE}&state=test-state`) =>
  withCookies(302, 'Found', { location }, [cookie('auth0', 'test-auth0-resumed')])

export const tokenReply = (accessToken = TEST_ACCESS_TOKEN) =>
  jsonResponse({
    access_token: accessToken,
    refresh_token: TEST_REFRESH_TOKEN,
    id_token: TEST_ID_TOKEN,
    scope: 'openid offline_access comfortcloud.control a2w.control',
    expires_in: 86400,
    token_type: 'Bearer',
  })

/** Auth0's refusal; the description echoes the account to prove it never reaches an error. */
export const rejectedPassword = (status = 401) =>
  jsonResponse(
    {
      name: 'ValidationError',
      code: 'invalid_user_password',
      description: `Wrong email or password for ${TEST_USER}`,
      statusCode: 400,
    },
    { status },
  )

/** The six Auth0 routes of a password login; tokens are handed out in order (the last repeats). */
export function authRoutes(tokens: string[] = [TEST_ACCESS_TOKEN, TEST_ACCESS_TOKEN_2]) {
  let issued = 0
  const routes: Record<string, FakeRoute> = {
    [ROUTES.authorize]: () => authorizeRedirect(),
    [ROUTES.loginPage]: () => loginPage(),
    [ROUTES.password]: () => callbackForm(),
    [ROUTES.callback]: () => callbackRedirect(),
    [ROUTES.resume]: () => resumeRedirect(),
    [ROUTES.token]: () => tokenReply(tokens[Math.min(issued++, tokens.length - 1)]),
  }
  return routes
}

export const accLoginReply = () =>
  jsonResponse({ country: 'SE', extUsrId: TEST_EXT_USER_ID, clientId: TEST_CLIENT_ID, language: 0 })

/** An accsmart error body: `{ code, message }` with the status (4106 = newer app, 4103 = terms). */
export const apiError = (status: number, code: number) =>
  jsonResponse({ code, message: `test error ${code}` }, { status })

const acDevice = (deviceGuid: string, deviceName: string) => ({
  deviceGuid,
  deviceType: '1',
  deviceName,
  permission: 3,
  temperatureUnit: 0,
  summerHouse: 0,
  nanoeStandAlone: false,
  autoMode: true,
  powerConsumptionFlg: true,
  modeAvlList: { autoMode: 1 },
  parameters: {
    operate: 1,
    operationMode: 3,
    temperatureSet: 21,
    fanSpeed: 0,
    fanAutoMode: 1,
    airSwingLR: 2,
    airSwingUD: 0,
    ecoFunctionData: 0,
    ecoMode: 0,
    ecoNavi: 1,
    nanoe: 1,
    iAuto: 0,
    airDirection: 0,
    lastSettingMode: 0,
    airQuality: 0,
  },
  deviceModuleNumber: MODEL,
  deviceHashGuid: '0'.repeat(64),
  modelVersion: 0,
  coordinableFlg: false,
  pairedFlg: false,
  devicePositionId: 0,
})

export const deviceGroupBody = () => ({
  uiFlg: false,
  groupCount: 2,
  groupList: [
    {
      groupId: 1,
      groupName: 'Test house',
      pairingList: [],
      deviceList: [acDevice(MATSAL_GUID, 'Matsal'), acDevice(OVERVANING_GUID, 'Övervåning')],
    },
    {
      groupId: 2,
      groupName: 'Test garage',
      pairingList: [],
      deviceList: [
        {
          deviceGuid: AQUAREA_GUID,
          deviceType: '2',
          deviceName: 'Aquarea',
          deviceModuleNumber: 'WH-TEST',
          parameters: {},
        },
      ],
    },
  ],
})
export const deviceGroupReply = () => jsonResponse(deviceGroupBody())

const ELECTRIC_RATE = {
  weekdayBaseRate: NO,
  currency: 'kr',
  weekendBaseRate: NO,
  weekendDifferentRateTime: [],
  weekdayDifferentRateTime: [],
}

/** Synthetic kWh for hour `h` (distinct per hour, so a shifted hour shows). */
export const syntheticKwh = (h: number) => Math.round((0.05 + h * 0.01) * 1000) / 1000

/** One day-mode row as the API sends it; `filled: false` is an hour not reached yet (all -255). */
export function dayRow(day: string, h: number, filled = true): Record<string, unknown> {
  const v = (x: number) => (filled ? x : NO)
  return {
    dataTime: `${day.replaceAll('-', '')} ${String(h).padStart(2, '0')}`,
    averageSettingTemp: v(21),
    averageInsideTemp: v(20 + (h % 4) * 0.25),
    averageOutsideTemp: v(-3 + h * 0.25),
    consumption: v(syntheticKwh(h)),
    cost: NO,
    heatConsumptionRate: v(1),
    coolConsumptionRate: v(0),
    heatCostRate: NO,
    coolCostRate: NO,
  }
}

export function dayHistoryBody(
  day: string,
  o: {
    filledHours?: number
    /** `null` omits the field. */
    registerTime?: string | null
    /** 0 = Celsius (the default); `null` omits the field. */
    temperatureUnit?: number | null
    row?: (row: Record<string, unknown>, h: number) => Record<string, unknown>
  } = {},
) {
  const filled = o.filledHours ?? 24
  const rows = Array.from({ length: 24 }, (_, h) => {
    const row = dayRow(day, h, h < filled)
    return o.row ? o.row(row, h) : row
  })
  return {
    ...(o.temperatureUnit === null ? {} : { temperatureUnit: o.temperatureUnit ?? 0 }),
    ...(o.registerTime === null ? {} : { deviceRegisterTime: o.registerTime ?? '20241031' }),
    historyDataList: rows,
    electricRate: ELECTRIC_RATE,
  }
}
export const dayHistoryReply = (day: string, o?: Parameters<typeof dayHistoryBody>[1]) =>
  jsonResponse(dayHistoryBody(day, o))

/** One row per day of `month` ('YYYY-MM'); days from `filledDays` + 1 on are -255. */
export function monthHistoryBody(
  month: string,
  o: {
    filledDays?: number
    emptyDays?: number[]
    registerTime?: string
    temperatureUnit?: number
  } = {},
) {
  const [y, m] = month.split('-').map(Number)
  const length = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const filled = o.filledDays ?? length
  const rows = Array.from({ length }, (_, i) => {
    const d = i + 1
    const has = d <= filled && !o.emptyDays?.includes(d)
    const v = (x: number) => (has ? x : NO)
    return {
      dataTime: `${month.replace('-', '')}${String(d).padStart(2, '0')}`,
      averageSettingTemp: v(21),
      averageInsideTemp: v(20.5),
      averageOutsideTemp: v(-2 + d * 0.5),
      consumption: v(Math.round((2.5 + d * 0.1) * 1000) / 1000),
      cost: NO,
      heatConsumptionRate: v(1),
      coolConsumptionRate: v(0),
      heatCostRate: NO,
      coolCostRate: NO,
    }
  })
  return {
    temperatureUnit: o.temperatureUnit ?? 0,
    deviceRegisterTime: o.registerTime ?? '20241031',
    historyDataList: rows,
    electricRate: ELECTRIC_RATE,
  }
}
export const monthHistoryReply = (month: string, o?: Parameters<typeof monthHistoryBody>[1]) =>
  jsonResponse(monthHistoryBody(month, o))

/** A trimmed Play Store page carrying `version` where upstream's regex finds it. */
export const playStorePage = (version: string) =>
  html(
    `<html><script>AF_initDataCallback({key: 'ds:5', data:[[["${version}"]],[[[33]]]]});</script></html>`,
  )

/** Values that must never appear in an error (message, cause or stack). */
export const SECRETS = [
  TEST_USER,
  TEST_PASSWORD,
  TEST_ACCESS_TOKEN,
  TEST_ACCESS_TOKEN_2,
  TEST_REFRESH_TOKEN,
  TEST_ID_TOKEN,
  TEST_CODE,
  TEST_CSRF,
  TEST_WRESULT,
  TEST_MFA_TOKEN,
  TEST_GUARDIAN_TOKEN,
  TEST_CLIENT_ID,
  TEST_EXT_USER_ID,
  MATSAL_GUID,
  OVERVANING_GUID,
  'Bearer ',
  '<html',
  '<input',
]

/** The SECRETS (plus `extra`) found in an error's message, cause or stack; [] when clean. */
export function secretsIn(err: unknown, extra: string[] = []): string[] {
  const e = err as { message?: unknown; cause?: unknown; stack?: unknown } | null
  const cause = e?.cause as { message?: unknown } | undefined
  const text = [
    String(e?.message),
    JSON.stringify(e?.cause ?? null),
    String(cause?.message),
    String(e?.stack),
  ].join(' ')
  return [...SECRETS, ...extra].filter((s) => text.includes(s))
}
