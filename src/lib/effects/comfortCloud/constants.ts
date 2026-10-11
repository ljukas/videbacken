// Copied from aio-panasonic-comfort-cloud 2026.8.9 (MIT, © Jimmy Everling): constants.py,
// panasonicrequestheader.py, panasonicauthentication.py, ccappversion.py. They are the Comfort
// Cloud Android app's own values. When Panasonic changes the login (the source fails as
// auth_failed / unexpected_response), diff upstream's newest release against these and update
// them together, bumping UPSTREAM_VERSION.
export const UPSTREAM_VERSION = '2026.8.9'

export const AUTH_BASE = 'https://authglb.digital.panasonic.com'
export const ACC_BASE = 'https://accsmart.panasonic.com'

export const APP_CLIENT_ID = 'Xmy6xIYIitMxngjB2rHvlm6HSDNnaMJx'
export const AUTH0_CLIENT =
  'eyJuYW1lIjoiQXV0aDAuQW5kcm9pZCIsImVudiI6eyJhbmRyb2lkIjoiMzAifSwidmVyc2lvbiI6IjIuOS4zIn0='
export const REDIRECT_URI =
  'panasonic-iot-cfc://authglb.digital.panasonic.com/android/com.panasonic.ACCsmart/callback'
export const AUDIENCE = `https://digital.panasonic.com/${APP_CLIENT_ID}/api/v1/`
export const SCOPE = 'openid offline_access comfortcloud.control a2w.control'
export const AUTH0_TENANT = 'pdpauthglb-a1'
export const AUTH0_CONNECTION = 'PanasonicID-Authentication'
export const AUTH_API_USER_AGENT = 'okhttp/4.10.0'
export const AUTH_BROWSER_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Mobile Safari/537.36'

export const APP_NAME = 'Comfort Cloud'
/** The key baked into the app that `x-cfc-api-key` hashes (panasonicrequestheader.py). */
export const APP_KEY = '521325fb2dd486bf4831b47644317fca'
export const API_USER_AGENT = 'G-RAC'
/** The app version at the 2026-10-08 probe. A 401 + 4106 swaps it in memory for the Play Store's. */
export const PINNED_APP_VERSION = '4.4.0'
export const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.panasonic.ACCsmart'
/** Upstream's `_update_playstore` pattern. */
export const PLAY_STORE_VERSION_RE = /\["(\d+\.\d+\.\d+)"\]/

/** `deviceHistoryData` modes (constants.DataMode): 24 hourly rows, or one row per day of the month. */
export const DATA_MODE_DAY = 0
export const DATA_MODE_MONTH = 2
/** Every history request: rows are then exact UTC hours, DST-proof (spec, live probe). */
export const OS_TIMEZONE = '+00:00'
