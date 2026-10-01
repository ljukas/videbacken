import { expect, test } from 'vitest'
import { SKODA_EXPORT_FIXTURE as fixture } from '~test/fixtures/skodaExport'
import { parseSkodaExport } from './skodaExport'

test('parses the export (BOM, CRLF, quoted commas), dropping unreadable rows', () => {
  const result = parseSkodaExport(fixture)
  expect(result).toMatchObject({ ok: true, dropped: 1, publicCount: 1 })
  if (!result.ok) throw new Error('unreachable')
  expect(result.rows).toEqual([
    {
      sourceSessionId: 's-1',
      startAt: new Date('2026-02-10T11:00:00Z'),
      endAt: new Date('2026-02-10T13:00:00Z'),
      energyKwh: 12,
      startSocPercent: 20,
      endSocPercent: 45,
      isPublic: false,
    },
    {
      sourceSessionId: 's-2',
      startAt: new Date('2026-03-01T08:00:00Z'),
      endAt: new Date('2026-03-01T09:30:00Z'),
      energyKwh: 8,
      startSocPercent: 50,
      endSocPercent: 70,
      isPublic: false,
    },
    {
      sourceSessionId: 's-3',
      startAt: new Date('2026-03-05T12:00:00Z'),
      endAt: new Date('2026-03-05T12:40:00Z'),
      energyKwh: 30,
      startSocPercent: 10,
      endSocPercent: 80,
      isPublic: true,
    },
  ])
  expect(result.from).toEqual(new Date('2026-02-10T11:00:00Z'))
  expect(result.to).toEqual(new Date('2026-03-05T12:40:00Z'))
})

test('never carries the location name or price', () => {
  const result = parseSkodaExport(fixture)
  expect(JSON.stringify(result)).not.toContain('Testgatan')
  expect(JSON.stringify(result)).not.toContain('199')
})

test('rejects a file that is not a MySkoda export', () => {
  expect(parseSkodaExport('name,email\nA,a@b.c\n')).toEqual({
    ok: false,
    error: 'not_skoda_export',
  })
  expect(parseSkodaExport('')).toEqual({ ok: false, error: 'not_skoda_export' })
})

test('a header with no readable rows is empty', () => {
  const header = fixture.split(/\r?\n/)[0]
  expect(parseSkodaExport(`${header}\r\n`)).toEqual({ ok: false, error: 'empty' })
})

test('missing SoC becomes null; a blank Started on is dropped', () => {
  const header = fixture.split(/\r?\n/)[0]
  const text = `${header}\n"x","2026-02-01T10:00:00Z","2026-02-01T11:00:00Z","","","3.00","","","","","","","","","",""\n"y","","2026-02-01T11:00:00Z","","","3.00","","","","","","","","","",""`
  const result = parseSkodaExport(text)
  expect(result).toMatchObject({ ok: true, dropped: 1 })
  if (result.ok)
    expect(result.rows[0]).toMatchObject({ startSocPercent: null, endSocPercent: null })
})

test('a blank energy is dropped, not counted as 0 kWh', () => {
  const header = fixture.split(/\r?\n/)[0]
  const text = `${header}\n"x","2026-02-01T10:00:00Z","2026-02-01T11:00:00Z","","","","","","","","","","","","",""\n"z","2026-02-02T10:00:00Z","2026-02-02T11:00:00Z","","","2.00","","","","","","","","","",""`
  const result = parseSkodaExport(text)
  expect(result).toMatchObject({ ok: true, dropped: 1 })
  if (result.ok) expect(result.rows.map((r) => r.sourceSessionId)).toEqual(['z'])
})
