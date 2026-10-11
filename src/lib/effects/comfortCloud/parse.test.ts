import { describe, expect, test } from 'vitest'
import { ComfortCloudError } from './errors'
import {
  AQUAREA_GUID,
  dayHistoryBody,
  dayRow,
  deviceGroupBody,
  MATSAL_GUID,
  MODEL,
  monthHistoryBody,
  NO,
  OVERVANING_GUID,
  secretsIn,
  syntheticKwh,
} from './fixtures'
import {
  parseAccLogin,
  parseDayHistory,
  parseJson,
  parseMonthHistory,
  parseToken,
  parseUnits,
} from './parse'

const caught = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    return e as ComfortCloudError
  }
  throw new Error('expected a throw')
}
const HOUR = 3_600_000

describe('units', () => {
  test('lists the air conditioners in order, skipping Aquarea', () => {
    expect(parseUnits(deviceGroupBody())).toEqual([
      { guid: MATSAL_GUID, name: 'Matsal', model: MODEL },
      { guid: OVERVANING_GUID, name: 'Övervåning', model: MODEL },
    ])
  })

  test('skips devices without parameters, the HWS tank, nulls and repeats; tolerates no groups', () => {
    // A loose view of the fixture: the test adds devices of other shapes on purpose.
    const body = deviceGroupBody() as unknown as { groupList: { deviceList: unknown[] }[] }
    body.groupList[1].deviceList.push(
      {
        deviceGuid: 'HWS+1',
        deviceType: '11',
        deviceName: 'Tank',
        deviceModuleNumber: 'HE',
        parameters: {},
      },
      { deviceGuid: 'NOPARAMS+1', deviceType: '1', deviceName: 'X', deviceModuleNumber: MODEL },
      null,
      { ...(body.groupList[0].deviceList[0] as object) },
    )
    expect(parseUnits(body).map((u) => u.guid)).toEqual([MATSAL_GUID, OVERVANING_GUID])
    expect(parseUnits({ uiFlg: false, groupCount: 0 })).toEqual([])
    expect(parseUnits({ groupList: [{ deviceList: null }] })).toEqual([])
    expect(parseUnits(body).some((u) => u.guid === AQUAREA_GUID)).toBe(false)
  })

  test('reads deviceIdList when deviceList is absent, and keeps `parameters: null` on an AC', () => {
    const ac = (deviceGuid: string, parameters: unknown) => ({
      deviceGuid,
      deviceType: '1',
      deviceName: 'X',
      deviceModuleNumber: MODEL,
      parameters,
    })
    expect(
      parseUnits({ groupList: [{ deviceIdList: [ac('ID+1', {})] }] }).map((u) => u.guid),
    ).toEqual(['ID+1'])
    expect(
      parseUnits({ groupList: [{ deviceList: [ac('NULLP+1', null)] }] }).map((u) => u.guid),
    ).toEqual(['NULLP+1'])
    const absent = { ...ac('ABSENT+1', {}) } as Record<string, unknown>
    delete absent.parameters
    expect(parseUnits({ groupList: [{ deviceList: [absent] }] })).toEqual([])
  })

  test('an empty deviceList falls back to deviceIdList (upstream: `deviceList or deviceIdList`)', () => {
    const ac = {
      deviceGuid: 'ID+2',
      deviceType: '1',
      deviceName: 'X',
      deviceModuleNumber: MODEL,
      parameters: {},
    }
    expect(
      parseUnits({ groupList: [{ deviceList: [], deviceIdList: [ac] }] }).map((u) => u.guid),
    ).toEqual(['ID+2'])
  })

  test('a nameless unit is named by its model', () => {
    const body = deviceGroupBody() as unknown as {
      groupList: { deviceList: { deviceName: string | null }[] }[]
    }
    body.groupList[0].deviceList[0].deviceName = null
    expect(parseUnits(body)[0]).toEqual({ guid: MATSAL_GUID, name: MODEL, model: MODEL })
  })

  test('a wrong shape is unexpected_response naming the path, never a value', () => {
    const err = caught(() => parseUnits({ groupList: [{ deviceList: [{ deviceGuid: 42 }] }] }))
    expect(err).toBeInstanceOf(ComfortCloudError)
    expect(err).toMatchObject({ code: 'unexpected_response', op: 'units' })
    expect(err.message).toContain('groupList.0.deviceList.0.deviceGuid')
    expect(err.message).not.toContain('42')
  })
})

describe('day history', () => {
  test('a full day is 24 exact UTC hours with every value mapped', () => {
    const h = parseDayHistory('2026-06-10', dayHistoryBody('2026-06-10'))
    expect(h.registeredOn).toBe('2024-10-31')
    expect(h.rows).toHaveLength(24)
    expect(h.rows[0]).toEqual({
      hourStart: new Date('2026-06-10T00:00:00Z'),
      energyKwh: syntheticKwh(0),
      heatShare: 1,
      coolShare: 0,
      setpointC: 21,
      insideC: 20,
      outsideC: -3,
    })
    expect(h.rows[23].hourStart).toEqual(new Date('2026-06-10T23:00:00Z'))
  })

  test('both DST days are 24 UTC hours', () => {
    for (const day of ['2025-10-26', '2026-03-29']) {
      const rows = parseDayHistory(day, dayHistoryBody(day)).rows
      expect(rows).toHaveLength(24)
      expect(rows[23].hourStart.getTime() - rows[0].hourStart.getTime()).toBe(23 * HOUR)
    }
  })

  test('future hours (consumption -255) are dropped', () => {
    const rows = parseDayHistory(
      '2026-06-10',
      dayHistoryBody('2026-06-10', { filledHours: 10 }),
    ).rows
    expect(rows.map((r) => r.hourStart.getUTCHours())).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  test('a -255 temperature or share with a real kWh keeps the kWh and stores null', () => {
    const body = dayHistoryBody('2026-06-10', {
      row: (row, h) =>
        h === 3
          ? {
              ...row,
              averageInsideTemp: NO,
              averageOutsideTemp: NO,
              averageSettingTemp: NO,
              heatConsumptionRate: NO,
              coolConsumptionRate: NO,
            }
          : row,
    })
    expect(parseDayHistory('2026-06-10', body).rows[3]).toEqual({
      hourStart: new Date('2026-06-10T03:00:00Z'),
      energyKwh: syntheticKwh(3),
      heatShare: null,
      coolShare: null,
      setpointC: null,
      insideC: null,
      outsideC: null,
    })
  })

  test('null optional fields are null and the kWh is kept', () => {
    const body = dayHistoryBody('2026-06-10', {
      row: (row, h) =>
        h === 5
          ? {
              ...row,
              averageOutsideTemp: null,
              heatConsumptionRate: null,
              coolConsumptionRate: null,
            }
          : row,
    })
    expect(parseDayHistory('2026-06-10', body).rows[5]).toMatchObject({
      energyKwh: syntheticKwh(5),
      heatShare: null,
      coolShare: null,
      outsideC: null,
      insideC: 20.25,
    })
  })

  test('a null consumption is still a wrong shape', () => {
    const body = dayHistoryBody('2026-06-10', {
      row: (row, h) => (h === 5 ? { ...row, consumption: null } : row),
    })
    expect(caught(() => parseDayHistory('2026-06-10', body))).toMatchObject({
      code: 'unexpected_response',
      op: 'history',
    })
  })

  test('absent optional fields are null; other values pass through for the service to judge', () => {
    const body = dayHistoryBody('2026-06-10', {
      row: (row, h) =>
        h === 0
          ? { dataTime: row.dataTime, consumption: 0.2 }
          : { ...row, averageOutsideTemp: -40.5 },
    })
    const rows = parseDayHistory('2026-06-10', body).rows
    expect(rows[0]).toMatchObject({ energyKwh: 0.2, heatShare: null, insideC: null })
    expect(rows[1].outsideC).toBe(-40.5)
  })

  test('a real consumption of 0 is kept (an idle hour is data)', () => {
    const body = dayHistoryBody('2026-06-10', {
      row: (row, h) => (h === 4 ? { ...row, consumption: 0 } : row),
    })
    const rows = parseDayHistory('2026-06-10', body).rows
    expect(rows).toHaveLength(24)
    expect(rows[4].energyKwh).toBe(0)
  })

  test('rows arrive in any order and come back ascending', () => {
    const body = dayHistoryBody('2026-06-10')
    body.historyDataList.reverse()
    const rows = parseDayHistory('2026-06-10', body).rows
    expect(rows.map((r) => r.hourStart.getUTCHours())).toEqual(
      Array.from({ length: 24 }, (_, h) => h),
    )
  })

  test('a row of another day, or an impossible hour, is unexpected_response', () => {
    for (const dataTime of [
      '20260611 00',
      '20260609 23',
      '20260610 24',
      '20260610',
      '2026-06-10 01',
    ]) {
      const body = dayHistoryBody('2026-06-10', {
        row: (row, h) => (h === 5 ? { ...row, dataTime } : row),
      })
      const err = caught(() => parseDayHistory('2026-06-10', body))
      expect(err, dataTime).toMatchObject({ code: 'unexpected_response', op: 'history' })
      expect(err.message).toContain('row 5')
      expect(err.message).not.toContain(dataTime)
    }
  })

  test('a repeated hour is unexpected_response', () => {
    const body = dayHistoryBody('2026-06-10', {
      row: (row, h) => (h === 7 ? dayRow('2026-06-10', 6) : row),
    })
    expect(caught(() => parseDayHistory('2026-06-10', body)).message).toContain('repeats an hour')
  })

  test('a missing or impossible deviceRegisterTime is unexpected_response', () => {
    for (const registerTime of [null, '2024103', '20241332', '2024-10-31']) {
      const err = caught(() =>
        parseDayHistory('2026-06-10', dayHistoryBody('2026-06-10', { registerTime })),
      )
      expect(err, String(registerTime)).toMatchObject({
        code: 'unexpected_response',
        op: 'history',
      })
    }
  })

  test('temperatures in anything but Celsius fail the call, naming the unit setting', () => {
    for (const temperatureUnit of [1, 2]) {
      const body = dayHistoryBody('2026-06-10', { temperatureUnit })
      const err = caught(() => parseDayHistory('2026-06-10', body))
      expect(err, String(temperatureUnit)).toMatchObject({
        code: 'unexpected_response',
        op: 'history',
      })
      expect(err.message).toContain('temperatureUnit')
      expect(err.message).toContain('Celsius')
    }
    const month = monthHistoryBody('2026-06', { temperatureUnit: 1 })
    expect(caught(() => parseMonthHistory('2026-06', month)).message).toContain('Celsius')
    // a missing unit is a shape error, not a silent Celsius
    const missing = dayHistoryBody('2026-06-10', { temperatureUnit: null })
    expect(caught(() => parseDayHistory('2026-06-10', missing)).message).toContain(
      'temperatureUnit',
    )
  })

  test('more rows than any day has, or not an object, is unexpected_response', () => {
    const body = dayHistoryBody('2026-06-10')
    body.historyDataList = [...body.historyDataList, ...body.historyDataList]
    expect(caught(() => parseDayHistory('2026-06-10', body)).code).toBe('unexpected_response')
    expect(caught(() => parseDayHistory('2026-06-10', 'x')).code).toBe('unexpected_response')
  })

  test('the row limit alone fails, naming the shape path', () => {
    // 41 distinct, valid month rows: only the limit can reject them.
    const body = monthHistoryBody('2026-06')
    body.historyDataList = Array.from({ length: 41 }, (_, i) => ({
      ...body.historyDataList[0],
      dataTime: `2026${String(Math.floor(i / 28) + 1).padStart(2, '0')}${String((i % 28) + 1).padStart(2, '0')}`,
    }))
    const err = caught(() => parseMonthHistory('2026-06', body))
    expect(err).toMatchObject({ code: 'unexpected_response', op: 'history' })
    expect(err.message).toContain('historyDataList')
  })
})

describe('month history', () => {
  test('one row per day with data, -255 days dropped, ascending', () => {
    const h = parseMonthHistory(
      '2026-06',
      monthHistoryBody('2026-06', { filledDays: 10, emptyDays: [4] }),
    )
    expect(h.registeredOn).toBe('2024-10-31')
    expect(h.rows.map((r) => r.day)).toEqual([
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
      '2026-06-05',
      '2026-06-06',
      '2026-06-07',
      '2026-06-08',
      '2026-06-09',
      '2026-06-10',
    ])
    expect(h.rows[0]).toEqual({ day: '2026-06-01', energyKwh: 2.6 })
  })

  test('a day of another month, an impossible day or a repeated day is unexpected_response', () => {
    for (const dataTime of ['20260701', '20260631', '20260600', '2026060']) {
      const body = monthHistoryBody('2026-06')
      body.historyDataList[2] = { ...body.historyDataList[2], dataTime }
      const err = caught(() => parseMonthHistory('2026-06', body))
      expect(err, dataTime).toMatchObject({ code: 'unexpected_response', op: 'history' })
      expect(err.message).not.toContain(dataTime)
    }
    const body = monthHistoryBody('2026-06')
    body.historyDataList[3] = { ...body.historyDataList[3], dataTime: '20260603' }
    expect(caught(() => parseMonthHistory('2026-06', body)).message).toContain('repeats a day')
  })
})

describe('month history edge cases', () => {
  test('a real consumption of 0 is kept', () => {
    const body = monthHistoryBody('2026-06')
    body.historyDataList[1] = { ...body.historyDataList[1], consumption: 0 }
    const rows = parseMonthHistory('2026-06', body).rows
    expect(rows).toHaveLength(30)
    expect(rows[1]).toEqual({ day: '2026-06-02', energyKwh: 0 })
  })

  test('rows arrive in any order and come back ascending', () => {
    const body = monthHistoryBody('2026-06')
    body.historyDataList.reverse()
    const days = parseMonthHistory('2026-06', body).rows.map((r) => r.day)
    expect(days).toEqual([...days].sort())
    expect(days[0]).toBe('2026-06-01')
    expect(days).toHaveLength(30)
  })

  test('a month that is not a real YYYY-MM is a RangeError', () => {
    for (const month of ['2026-13', '2026-6', '2026-00', 'x', '2026-06-01']) {
      expect(() => parseMonthHistory(month, monthHistoryBody('2026-06')), month).toThrow(RangeError)
    }
  })
})

describe('login answers', () => {
  test('the token and the client id', () => {
    expect(parseToken({ access_token: 'tok', expires_in: 86400 })).toBe('tok')
    expect(parseAccLogin({ country: 'SE', clientId: 'cid', language: 0 })).toBe('cid')
  })

  test('a missing token or client id is unexpected_response on login, naming no value', () => {
    for (const fn of [
      () => parseToken({ refresh_token: 'r-secret' }),
      () => parseAccLogin({ extUsrId: 'u-secret' }),
    ]) {
      const err = caught(fn)
      expect(err).toMatchObject({ code: 'unexpected_response', op: 'login' })
      expect(secretsIn(err, ['r-secret', 'u-secret'])).toEqual([])
    }
  })

  test('a body that is not JSON is unexpected_response', () => {
    expect(caught(() => parseJson('units', '<html>oops</html>'))).toMatchObject({
      code: 'unexpected_response',
      op: 'units',
      message: 'Comfort Cloud units response is not valid JSON',
    })
  })
})
