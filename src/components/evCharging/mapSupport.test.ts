import { expect, test } from 'vitest'
import { mapErrorLogFields } from './mapSupport'

test('a map error is reduced to its name and HTTP status, never its message or URL', () => {
  const ajax = {
    name: 'AJAXError',
    status: 503,
    message:
      'AJAXError: Service Unavailable (503): https://tiles.openfreemap.org/planet/x/14/8765/4567.pbf',
    url: 'https://tiles.openfreemap.org/planet/x/14/8765/4567.pbf',
    stack: 'AJAXError: ... https://tiles.openfreemap.org/planet/x/14/8765/4567.pbf',
  }
  const fields = mapErrorLogFields(ajax)
  expect(fields).toEqual({ name: 'AJAXError', status: 503 })
  const json = JSON.stringify(fields)
  expect(json).not.toContain('openfreemap')
  expect(json).not.toMatch(/\d+\/\d+/)
})

test('an error without a status or a plain name still yields a safe name', () => {
  expect(mapErrorLogFields(new Error('boom https://x/1/2/3'))).toEqual({ name: 'Error' })
  expect(mapErrorLogFields({ name: 'https://x/14/8765/4567' })).toEqual({ name: 'Error' })
  expect(mapErrorLogFields(undefined)).toEqual({ name: 'Error' })
  expect(mapErrorLogFields('text')).toEqual({ name: 'Error' })
})
