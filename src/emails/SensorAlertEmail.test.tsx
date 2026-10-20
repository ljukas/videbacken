import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { renderSensorAlert, type SensorAlertEmailProps } from './SensorAlertEmail'

beforeAll(() => {
  process.env.BETTER_AUTH_URL ??= 'https://videbacken.example'
  // The mails' dates leave out the year of "now" (Stockholm): pin it to the fixtures' year.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2027-01-20T12:00:00Z'))
})

afterAll(() => {
  vi.useRealTimers()
})

const BASE: SensorAlertEmailProps = {
  to: 'a@test.videbacken.local',
  locale: 'sv',
  transition: 'fired',
  sensorName: 'Förråd',
  kind: 'temperature',
  direction: 'below',
  threshold: 5,
  count: 2,
  value: 4.8,
  since: '2027-01-15T12:00:00Z', // 13:00 Stockholm
  endedAt: null,
}

test('the fired temperature mail', async () => {
  const { subject, html, text } = await renderSensorAlert(BASE)
  expect(subject).toBe('⚠️ Förråd: temperaturen är under 5 °C')
  for (const out of [html, text]) {
    expect(out).toContain(
      'Temperaturen på Förråd har legat under din gräns på 5 °C i 2 mätningar i rad.',
    )
    expect(out).toContain('4,8 °C')
    expect(out).toContain('15 jan. 13:00')
    expect(out).toContain('Under gränsen sedan')
    expect(out).toContain(
      'Du får inga fler mejl om det här förrän temperaturen är tillbaka över 5 °C.',
    )
    expect(out).toContain('/sensors')
  }
  expect(text.toLowerCase()).toContain('förråd behöver tillsyn')
})

test('the recovered battery mail has the period and its duration', async () => {
  const { subject, text } = await renderSensorAlert({
    ...BASE,
    transition: 'recovered',
    kind: 'battery',
    threshold: 20,
    value: 95,
    since: '2027-01-15T12:00:00Z',
    endedAt: '2027-01-15T14:30:00Z',
  })
  expect(subject).toBe('✅ Förråd: batteriet är OK igen (95 %)')
  expect(text).toContain('Under gränsen: 15 jan. 13:00 – 15 jan. 15:30 (2 h 30 min)')
  expect(text.toLowerCase()).toContain('förråd är ok igen')
  expect(text).not.toContain('Du får inga fler mejl')
})

test('an above-humidity recovery says tillbaka under', async () => {
  const { subject } = await renderSensorAlert({
    ...BASE,
    transition: 'recovered',
    kind: 'humidity',
    direction: 'above',
    threshold: 80,
    value: 71,
    endedAt: '2027-01-15T13:00:00Z',
  })
  expect(subject).toBe('✅ Förråd: luftfuktigheten är tillbaka under 80 %')
})

test('English mirrors it', async () => {
  const { subject, text } = await renderSensorAlert({ ...BASE, locale: 'en', threshold: 5.5 })
  expect(subject).toBe('⚠️ Förråd: the temperature is below 5.5 °C')
  expect(text).toContain('The temperature on Förråd has been below your limit')
  expect(text).toContain('Open Climate')
})

test('a humidity value keeps its decimal: an above-80 alert on 80.4 never reads "80 %"', async () => {
  const { text } = await renderSensorAlert({
    ...BASE,
    kind: 'humidity',
    direction: 'above',
    threshold: 80,
    value: 80.4,
  })
  expect(text).toContain('Senaste mätning: 80,4 %')
})

test('a value that rounds to zero has no minus sign', async () => {
  const { text } = await renderSensorAlert({ ...BASE, threshold: 0.5, value: -0.04 })
  expect(text).toContain('Senaste mätning: 0,0 °C')
  expect(text).not.toContain('−0,0')
})

test('a date in another year than now shows its year', async () => {
  const { text } = await renderSensorAlert({ ...BASE, since: '2026-12-30T12:00:00Z' })
  expect(text).toContain('30 dec. 2026 13:00')
})

test('the subject is one line, and the name is escaped in the HTML', async () => {
  const { subject, html } = await renderSensorAlert({ ...BASE, sensorName: '<b>x</b>\r\nBcc: a@b' })
  expect(subject).not.toMatch(/[\r\n]/)
  expect(subject).toBe('⚠️ <b>x</b> Bcc: a@b: temperaturen är under 5 °C')
  expect(html).toContain('&lt;b&gt;')
  expect(html).not.toContain('<b>x</b>')
})
