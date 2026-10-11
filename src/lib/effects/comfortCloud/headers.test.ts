import { expect, test } from 'vitest'
import { PINNED_APP_VERSION } from './constants'
import { apiHeaders, appTimestamp, cfcApiKey } from './headers'

// Pinned against upstream aio-panasonic-comfort-cloud 2026.8.9 `PanasonicRequestHeader._get_api_key`.
// Reproduce by hand (see the plan's "Decisions"):
//   python3 -I -c "import hashlib,datetime;ts='2026-10-08 12:34:56';tok='test-access-token-not-real';ms=str(int(datetime.datetime.strptime(ts,'%Y-%m-%d %H:%M:%S').replace(tzinfo=datetime.timezone.utc).timestamp()*1000));h=hashlib.sha256(b''.join([b'Comfort Cloud',b'521325fb2dd486bf4831b47644317fca',ms.encode(),b'Bearer ',tok.encode()])).hexdigest();print(ms, h[:9]+'cfc'+h[9:])"
test('cfcApiKey matches upstream for a fixed timestamp and token', () => {
  expect(cfcApiKey('2026-10-08 12:34:56', 'test-access-token-not-real')).toBe(
    'f35f52721cfcd67f30ebc9e6f4dbe899423097c34ab154685f4a03dbc0826c3fa3d',
  )
})

test('cfcApiKey refuses anything but YYYY-MM-DD HH:mm:ss', () => {
  for (const bad of ['2026-10-08T12:34:56', '2026-10-08 12:34', '2026-10-08 12:34:56Z', ''])
    expect(() => cfcApiKey(bad, 't'), bad).toThrow(RangeError)
})

test('the app timestamp is the UTC wall clock to the second', () => {
  expect(appTimestamp(new Date('2026-10-08T12:34:56.789Z'))).toBe('2026-10-08 12:34:56')
})

test('apiHeaders carries every header upstream sends, the key signed over the same timestamp', () => {
  const now = new Date('2026-10-08T12:34:56.789Z')
  const headers = apiHeaders({
    now,
    token: 'test-access-token-not-real',
    appVersion: PINNED_APP_VERSION,
    clientId: 'cid',
  })
  expect(headers).toEqual({
    accept: 'application/json; charset=utf-8',
    'content-type': 'application/json',
    'user-agent': 'G-RAC',
    'x-app-name': 'Comfort Cloud',
    'x-app-timestamp': '2026-10-08 12:34:56',
    'x-app-type': '1',
    'x-app-version': '4.4.0',
    'x-cfc-api-key': 'f35f52721cfcd67f30ebc9e6f4dbe899423097c34ab154685f4a03dbc0826c3fa3d',
    'x-user-authorization-v2': 'Bearer test-access-token-not-real',
    'x-client-id': 'cid',
  })
  expect(apiHeaders({ now, token: 't', appVersion: '4.4.0' })).not.toHaveProperty('x-client-id')
})
