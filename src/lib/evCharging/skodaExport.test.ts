import { expect, test } from 'vitest'
import { SKODA_EXPORT_FIXTURE as fixture } from '~test/fixtures/skodaExport'
import { parseSkodaExport } from './skodaExport'
import { vehicleRecordInput } from './vehicle'

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

const header = fixture.split(/\r?\n/)[0].replace('\uFEFF', '')
const row = (cells: Record<string, string>) => {
  const cols = [...header.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'))
  const base: Record<string, string> = {
    'Session ID': 'r',
    'Started on': '2026-02-01T10:00:00Z',
    'Ended on': '2026-02-01T11:00:00Z',
    'Total energy (kWh)': '3.00',
    ...cells,
  }
  return cols.map((c) => `"${(base[c] ?? '').replace(/"/g, '""')}"`).join(',')
}
const withRows = (...rows: string[]) => `${header}\n${rows.join('\n')}\n`

test('every parsed row satisfies the server contract and carries no location or price', () => {
  const result = parseSkodaExport(fixture)
  if (!result.ok) throw new Error('unreachable')
  for (const r of result.rows) {
    expect(vehicleRecordInput.parse(r)).toEqual(r)
    expect(Object.keys(r).sort()).toEqual(
      [
        'endAt',
        'endSocPercent',
        'energyKwh',
        'isPublic',
        'sourceSessionId',
        'startAt',
        'startSocPercent',
      ].sort(),
    )
  }
  expect(JSON.stringify(result)).not.toContain('Testgatan')
})

test('from and to are the min start and max end, not the first and last row', () => {
  const result = parseSkodaExport(
    withRows(
      row({
        'Session ID': 'b',
        'Started on': '2026-03-01T10:00:00Z',
        'Ended on': '2026-03-01T11:00:00Z',
      }),
      row({
        'Session ID': 'a',
        'Started on': '2026-01-01T10:00:00Z',
        'Ended on': '2026-01-01T11:00:00Z',
      }),
      row({
        'Session ID': 'c',
        'Started on': '2026-02-01T10:00:00Z',
        'Ended on': '2026-04-01T11:00:00Z',
      }),
      row({
        'Session ID': 'd',
        'Started on': '2026-02-15T10:00:00Z',
        'Ended on': '2026-02-15T11:00:00Z',
      }),
    ),
  )
  if (!result.ok) throw new Error('unreachable')
  expect(result.from).toEqual(new Date('2026-01-01T10:00:00Z'))
  expect(result.to).toEqual(new Date('2026-04-01T11:00:00Z'))
})

test('SoC is rounded; unreadable or out-of-range SoC drops the row', () => {
  const result = parseSkodaExport(
    withRows(
      row({ 'Session ID': 'ok', 'Start SOC (%)': '20.6', 'End SOC (%)': '49.5' }),
      row({ 'Session ID': 'bad', 'Start SOC (%)': 'abc' }),
      row({ 'Session ID': 'high', 'End SOC (%)': '101' }),
    ),
  )
  if (!result.ok) throw new Error('unreachable')
  expect(result.dropped).toBe(2)
  expect(result.rows).toHaveLength(1)
  expect(result.rows[0]).toMatchObject({ startSocPercent: 21, endSocPercent: 50 })
})

test.each([
  'Session ID',
  'Started on',
  'Ended on',
  'Total energy (kWh)',
  'Start SOC (%)',
  'End SOC (%)',
  'Location name',
])('a header missing "%s" is not a MySkoda export', (col) => {
  const lines = fixture.replace('\uFEFF', '').split(/\r\n/)
  const idx = [...lines[0].matchAll(/"((?:[^"]|"")*)"/g)].findIndex((m) => m[1] === col)
  // Quoted commas make a naive split unsafe; rebuild each line from its quoted cells.
  const cut = (line: string) => {
    const cells = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[0])
    return cells.filter((_, i) => i !== idx).join(',')
  }
  const text = lines.filter(Boolean).map(cut).join('\r\n')
  expect(parseSkodaExport(text)).toEqual({ ok: false, error: 'not_skoda_export' })
})

test.each([
  ['blank Ended on', { 'Ended on': '' }],
  ['invalid Ended on', { 'Ended on': 'soon' }],
  ['end before start', { 'Ended on': '2026-02-01T09:00:00Z' }],
  ['blank Session ID', { 'Session ID': '   ' }],
  ['year before 2000', { 'Started on': '1999-12-31T10:00:00Z' }],
  ['zone-less Started on', { 'Started on': '2026-02-01T10:00:00' }],
  ['zone-less Ended on', { 'Ended on': '2026-02-01T11:00:00' }],
])('drops a row with %s', (_name, cells) => {
  const result = parseSkodaExport(withRows(row({ 'Session ID': 'keep' }), row(cells)))
  expect(result).toMatchObject({ ok: true, dropped: 1 })
})

test('accepts an explicit UTC offset', () => {
  const result = parseSkodaExport(withRows(row({ 'Started on': '2026-02-01T11:00:00+01:00' })))
  if (!result.ok) throw new Error('unreachable')
  expect(result.rows[0].startAt).toEqual(new Date('2026-02-01T10:00:00Z'))
})

test('a whitespace-only location is not public', () => {
  const result = parseSkodaExport(withRows(row({ 'Location name': '   ' })))
  if (!result.ok) throw new Error('unreachable')
  expect(result.rows[0].isPublic).toBe(false)
})
