import { expect, test } from 'vitest'
import { healthPoll } from './healthPoll'

const q = (data?: { running: boolean }) => ({ state: { data } })

test('polls every 5 s while this tab has a sync pending', () => {
  expect(healthPoll(true)(q({ running: false }))).toBe(5_000)
})
test('polls every 5 s while the server says running', () => {
  expect(healthPoll(false)(q({ running: true }))).toBe(5_000)
})
test('polls every minute otherwise', () => {
  expect(healthPoll(false)(q({ running: false }))).toBe(60_000)
})
test('polls every minute with no data yet', () => {
  expect(healthPoll(false)(q())).toBe(60_000)
})
