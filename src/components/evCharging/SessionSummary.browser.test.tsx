import { describe, expect, test } from 'vitest'
import { emptyTotals } from '~/lib/evCharging/cost'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
import { formatSek } from './format'
import { SessionSummary } from './SessionSummary'
import type { SolarValueInput } from './solarValue'

type Detail = RouterOutputs['evCharging']['session']
type Economy = Detail['economy']
type Counterfactual = NonNullable<Economy['counterfactual']>

const cost = (totalSek: number, kwh = 56) => ({
  ...emptyTotals(),
  kwh,
  gridKwh: kwh,
  fullKwh: kwh,
  totalSek,
})

// The owner's session: plugged in Sun 27 Sep 17:10 Stockholm, 56 kWh, the
// cheapest schedule Mon 00:00–06:30. Dearest 130,82 puts actual at 50 %.
const PLUG_IN = new Date('2026-09-27T15:10:00Z')
const QUARTER = 15 * 60_000
const quarters = (fromIso: string, toIso: string) => {
  const out: { startMs: number; endMs: number; kwh: number }[] = []
  for (let t = Date.parse(fromIso); t < Date.parse(toIso); t += QUARTER) {
    out.push({ startMs: t, endMs: t + QUARTER, kwh: 2 })
  }
  return out
}
const OWNER_SCHEDULE = quarters('2026-09-27T22:00:00Z', '2026-09-28T04:30:00Z')

// The cash cost (ADR-0023). By default it mirrors the grid-only actual with no
// house data, so the source bar is a sentence and the range bar the only image.
type Cash = Detail['cost']
const cash = (totalSek: number, over: Partial<Cash> = {}): Cash => ({
  ...cost(totalSek),
  noHouseDataKwh: 56,
  avgOre: (totalSek / 56) * 100,
  complete: true,
  ...over,
})

const counterfactual = (over: Partial<Counterfactual> = {}): Counterfactual => ({
  immediate: cost(128.27),
  optimal: cost(59.44),
  dearest: cost(130.82),
  score: 0.5,
  savedVsImmediateSek: 33.14,
  leftOnTableSek: 35.69,
  ...over,
})

// `over.economy` may flip the session to excluded (excluded + counterfactual:
// null together), which Partial<union> can't express, hence the cast.
const detail = (
  over: {
    economy?: Partial<Economy>
    estimated?: boolean
    optimalSchedule?: Detail['optimalSchedule']
    rateKw?: number | null
    peakKw?: number | null
    cost?: Cash
  } = {},
) => {
  const economy = {
    actual: cost(95.13),
    actualComplete: true,
    paidSpotOre: 40,
    windowAvgSpotOre: 55,
    excluded: null,
    counterfactual: counterfactual(),
    ...over.economy,
  } as Economy
  return {
    session: {
      id: '00000000-0000-4000-8000-000000000001',
      startAt: PLUG_IN,
      endAt: new Date('2026-09-28T14:49:00Z'),
      kwh: 56,
      peakKw: 'peakKw' in over ? (over.peakKw ?? null) : 8.9,
      estimated: over.estimated ?? false,
      vehicle: 'ours' as const,
      vehicleSource: 'default' as const,
    },
    economy,
    optimalSchedule: 'optimalSchedule' in over ? (over.optimalSchedule ?? null) : OWNER_SCHEDULE,
    rateKw: 'rateKw' in over ? (over.rateKw ?? null) : 8.9,
    cost: over.cost ?? cash(95.13),
  }
}

const excluded = (
  reason: 'no_hourly' | 'no_price',
  economy: Partial<Economy> = {},
  cashCost?: Cash,
) =>
  detail({
    economy: { excluded: reason, counterfactual: null, ...economy } as Partial<Economy>,
    optimalSchedule: null,
    rateKw: null,
    cost: cashCost,
  })

const render = (d: ReturnType<typeof detail>) => renderWithProviders(<SessionSummary detail={d} />)

test('the owner’s session: hero cost, verdict, sentence, range bar and both explained deltas', async () => {
  const { screen } = await render(detail())
  const card = screen.getByRole('group', { name: m.charging_session_fig_actual() })
  await expect.element(card).toMatchTextContent(/95,13\s?kr/)
  // The kWh lives in the page header, not repeated in the hero.
  expect(card.element().textContent).not.toMatch(/56,0\s?kWh/)
  await expect.element(card.getByText('1,70 kr/kWh i snitt')).toBeVisible()
  await expect.element(card.getByText(m.charging_session_verdict_ok())).toBeVisible()
  await expect
    .element(card.getByText(m.charging_session_verdict_ok()))
    .toHaveAttribute('data-verdict', 'ok')

  const sentence = m.charging_session_sentence_saved({
    left: formatSek(35.69, 2),
    saved: formatSek(33.14, 2),
  })
  expect(sentence.replaceAll('\u00a0', ' ')).toBe(
    '35,69 kr dyrare än billigaste möjliga, men 33,14 kr billigare än att ladda direkt vid inkoppling.',
  )
  await expect.element(card.getByText(sentence)).toBeVisible()

  await expect
    .element(card.getByText(m.charging_session_fig_score(), { exact: true }))
    .toBeVisible()
  await expect.element(card.getByText(/^50\s?%$/)).toBeVisible()

  const saved = screen.getByRole('group', { name: m.charging_session_saved_title() })
  await expect.element(saved).toMatchTextContent(/33,14\s?kr/)
  await expect
    .element(saved)
    .toMatchTextContent('Om bilen laddat med full fart från 17:10 (8,9 kW) tills den var klar.')
  const left = screen.getByRole('group', { name: m.charging_session_left_title() })
  await expect.element(left).toMatchTextContent(/35,69\s?kr/)
  await expect
    .element(left)
    .toMatchTextContent(
      'Om laddningen följt billigaste schemat (markerat i grafen): mån 00:00–06:30.',
    )
})

test('the range bar is one image summarised in its label, its markers placed between cheapest and dearest', async () => {
  const { screen } = await render(detail())
  const bar = screen.getByRole('img', {
    name: m.charging_session_range_label({
      actual: formatSek(95.13, 2),
      immediate: formatSek(128.27, 2),
      cheapest: formatSek(59.44, 2),
      dearest: formatSek(130.82, 2),
    }),
  })
  await expect.element(bar).toBeInTheDocument()
  const marker = (name: string) =>
    bar.element().querySelector<HTMLElement>(`[data-marker="${name}"]`)
  // (95,13 − 59,44) / (130,82 − 59,44) = 0,5; (128,27 − 59,44) / 71,38 = 0,964.
  expect(marker('actual')?.style.left).toBe('50%')
  expect(marker('immediate')?.style.left).toBe('96.4%')
  // The outline marker names what it is, as the sentence does.
  expect(m.charging_session_range_immediate()).toBe('Direkt vid inkoppling')
  // Every end and marker carries its kronor visibly too.
  for (const text of [
    `${m.charging_session_range_actual()} ${formatSek(95.13, 2)}`,
    `${m.charging_session_range_immediate()} ${formatSek(128.27, 2)}`,
    `${m.charging_session_range_cheapest()} ${formatSek(59.44, 2)}`,
    `${m.charging_session_range_dearest()} ${formatSek(130.82, 2)}`,
  ]) {
    // toMatchTextContent collapses the no-break space before "kr"; the expected text must too.
    await expect.element(bar).toMatchTextContent(text.replaceAll('\u00a0', ' '))
  }
})

test('a marker beyond the range is clamped to its end', async () => {
  const { screen } = await render(
    detail({ economy: { counterfactual: counterfactual({ immediate: cost(140) }) } }),
  )
  const immediate = screen
    .getByRole('img')
    .element()
    .querySelector<HTMLElement>('[data-marker="immediate"]')
  expect(immediate?.style.left).toBe('100%')
})

describe('verdict tiers', () => {
  test.each([
    [0.9, 'good', m.charging_session_verdict_good()],
    [0.67, 'good', m.charging_session_verdict_good()],
    // Graded on the shown whole percent: 2/3 reads "67 %", so it's good, not ok.
    [2 / 3, 'good', m.charging_session_verdict_good()],
    [0.329, 'ok', m.charging_session_verdict_ok()],
    [0.5, 'ok', m.charging_session_verdict_ok()],
    [0.2, 'poor', m.charging_session_verdict_poor()],
  ] as const)('score %s reads %s', async (score, verdict, label) => {
    const { screen } = await render(
      detail({ economy: { counterfactual: counterfactual({ score }) } }),
    )
    await expect.element(screen.getByText(label)).toHaveAttribute('data-verdict', verdict)
    await expect.element(screen.getByRole('img')).toBeInTheDocument()
  })

  test('no score: nothing to choose between, the spread instead of a bar', async () => {
    const { screen } = await render(
      detail({
        economy: {
          actual: cost(38.02),
          counterfactual: counterfactual({
            immediate: cost(38.03),
            optimal: cost(38),
            dearest: cost(38.04),
            score: null,
            savedVsImmediateSek: 0.01,
            leftOnTableSek: 0.02,
          }),
        },
      }),
    )
    await expect
      .element(screen.getByText(m.charging_session_verdict_none()))
      .toHaveAttribute('data-verdict', 'none')
    await expect
      .element(
        screen.getByText(m.charging_session_sentence_no_choice({ spread: formatSek(0.04, 2) })),
      )
      .toBeVisible()
    expect(screen.getByRole('img').elements()).toHaveLength(0)
    expect(
      screen.getByText(m.charging_session_fig_score(), { exact: true }).elements(),
    ).toHaveLength(0)
    // The deltas still explain the (tiny) figures.
    await expect
      .element(screen.getByRole('group', { name: m.charging_session_left_title() }))
      .toMatchTextContent(/0,02\s?kr/)
  })
})

describe('the verdict sentence', () => {
  test.each([
    [
      'dearer than charging at once',
      { score: 0.1, savedVsImmediateSek: -4, leftOnTableSek: 12 },
      () => m.charging_session_sentence_lost({ left: formatSek(12, 2), lost: formatSek(4, 2) }),
    ],
    [
      'about the same as charging at once',
      { score: 0.2, savedVsImmediateSek: 0.3, leftOnTableSek: 12 },
      () => m.charging_session_sentence_like_immediate({ left: formatSek(12, 2) }),
    ],
    [
      'nearly the cheapest',
      { score: 0.99, savedVsImmediateSek: 20, leftOnTableSek: 0.3 },
      () => m.charging_session_sentence_near_optimal_saved({ saved: formatSek(20, 2) }),
    ],
    [
      'nearly the cheapest, as charging at once',
      { score: 1, savedVsImmediateSek: 0, leftOnTableSek: 0 },
      () => m.charging_session_sentence_near_optimal_like_immediate(),
    ],
  ] as const)('%s', async (_name, over, expected) => {
    const { screen } = await render(detail({ economy: { counterfactual: counterfactual(over) } }))
    await expect.element(screen.getByText(expected())).toBeVisible()
  })

  test('the lost template says the overspend as a positive amount', () => {
    expect(
      m
        .charging_session_sentence_lost({ left: formatSek(12, 2), lost: formatSek(4, 2) })
        .replaceAll('\u00a0', ' '),
    ).toBe(
      '12,00 kr dyrare än billigaste möjliga och 4,00 kr dyrare än att ladda direkt vid inkoppling.',
    )
  })
})

describe('saved vs charging at once', () => {
  const savedTile = async (savedVsImmediateSek: number) => {
    const { screen } = await render(
      detail({ economy: { counterfactual: counterfactual({ savedVsImmediateSek }) } }),
    )
    return screen.getByRole('group', { name: m.charging_session_saved_title() })
  }

  test('a saving is good, with an arrow', async () => {
    const tile = await savedTile(33.14)
    expect(tile.element().querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('good')
  })

  test('a negative saving is signed and bad', async () => {
    const tile = await savedTile(-4)
    await expect.element(tile).toMatchTextContent(/−4,00\s?kr/)
    expect(tile.element().querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('bad')
  })

  test.each([
    ['a negligible saving', 0.3],
    ['a negligible loss', -0.3],
  ])('%s is neutral, so it never contradicts "ungefär lika"', async (_name, saved) => {
    const tile = await savedTile(saved)
    expect(tile.element().querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('neutral')
  })

  test('half a krona is the first coloured saving', async () => {
    const tile = await savedTile(0.5)
    expect(tile.element().querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('good')
  })

  test('without a score (nothing to choose between) the tile is neutral', async () => {
    const { screen } = await render(
      detail({
        economy: { counterfactual: counterfactual({ score: null, savedVsImmediateSek: 12 }) },
      }),
    )
    const tile = screen.getByRole('group', { name: m.charging_session_saved_title() })
    expect(tile.element().querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('neutral')
  })

  test('the rate is named when it matches the header peak', async () => {
    const { screen } = await render(detail({ peakKw: 5.29, rateKw: 5.29 }))
    const tile = screen.getByRole('group', { name: m.charging_session_saved_title() })
    await expect.element(tile).toMatchTextContent('(5,3 kW)')
  })

  test('a rate that differs from the header peak is worded without a number', async () => {
    const { screen } = await render(detail({ peakKw: 2.91, rateKw: 5.29 }))
    const tile = screen.getByRole('group', { name: m.charging_session_saved_title() })
    await expect
      .element(tile)
      .toMatchTextContent(m.charging_session_saved_explainer_no_rate({ time: '17:10' }))
    expect(tile.element().textContent).not.toMatch(/kW/)
  })

  test('without a header peak the rate is not named', async () => {
    const { screen } = await render(detail({ peakKw: null, rateKw: 5.29 }))
    const tile = screen.getByRole('group', { name: m.charging_session_saved_title() })
    expect(tile.element().textContent).not.toMatch(/5,3/)
  })

  test('zero is neutral, never "−0"', async () => {
    const tile = await savedTile(-0.001)
    await expect.element(tile).toMatchTextContent(/^[^−]*0,00\s?kr/)
    expect(tile.element().querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('neutral')
  })
})

describe('the cheapest windows', () => {
  const leftTile = async (optimalSchedule: Detail['optimalSchedule']) => {
    const { screen } = await render(detail({ optimalSchedule }))
    return screen.getByRole('group', { name: m.charging_session_left_title() })
  }
  const explained = (windows: string) => m.charging_session_left_explainer({ windows })

  test('one run on the plug-in day has no weekday', async () => {
    const tile = await leftTile(quarters('2026-09-27T16:00:00Z', '2026-09-27T18:00:00Z'))
    await expect.element(tile).toMatchTextContent(explained('18:00–20:00'))
  })

  test('one run on the next day gets its weekday', async () => {
    const tile = await leftTile(OWNER_SCHEDULE)
    await expect.element(tile).toMatchTextContent(explained('mån 00:00–06:30'))
  })

  test('two runs are both listed', async () => {
    const tile = await leftTile([
      ...quarters('2026-09-27T22:00:00Z', '2026-09-28T00:00:00Z'),
      ...quarters('2026-09-28T03:00:00Z', '2026-09-28T04:30:00Z'),
    ])
    await expect.element(tile).toMatchTextContent(explained('mån 00:00–02:00 och 05:00–06:30'))
  })

  test('three or more runs are counted, from the first start to the last end', async () => {
    const tile = await leftTile([
      ...quarters('2026-09-27T20:00:00Z', '2026-09-27T20:30:00Z'),
      ...quarters('2026-09-27T23:00:00Z', '2026-09-28T00:00:00Z'),
      ...quarters('2026-09-28T03:00:00Z', '2026-09-28T04:30:00Z'),
    ])
    await expect
      .element(tile)
      .toMatchTextContent(explained('3 perioder mellan 22:00 och mån 06:30'))
  })
})

describe('an excluded session', () => {
  test('no_hourly: only its cost and the reason — no verdict, bar or deltas', async () => {
    const { screen } = await render(excluded('no_hourly'))
    await expect.element(screen.getByText(m.charging_session_excluded_no_hourly())).toBeVisible()
    await expect.element(screen.getByText(/95,13/)).toBeVisible()
    for (const label of [
      m.charging_session_verdict_good(),
      m.charging_session_verdict_ok(),
      m.charging_session_verdict_poor(),
      m.charging_session_verdict_none(),
    ]) {
      expect(screen.getByText(label).elements()).toHaveLength(0)
    }
    expect(screen.getByRole('img').elements()).toHaveLength(0)
    expect(
      screen.getByRole('group', { name: m.charging_session_saved_title() }).elements(),
    ).toHaveLength(0)
    expect(
      screen.getByRole('group', { name: m.charging_session_left_title() }).elements(),
    ).toHaveLength(0)
    // Nothing added under the cost either.
    expect(screen.getByText(/kr\/kWh/).elements()).toHaveLength(0)
  })

  test('no_price with a complete actual shows the cost and the reason', async () => {
    const { screen } = await render(excluded('no_price'))
    await expect.element(screen.getByText(/95,13/)).toBeVisible()
    await expect.element(screen.getByText(m.charging_session_excluded_no_price())).toBeVisible()
    expect(screen.getByText(m.charging_sessions_cost_unknown()).elements()).toHaveLength(0)
    expect(screen.getByText(/kr\/kWh/).elements()).toHaveLength(0)
  })

  test('a partial actual shows "—" with its reason, never the partial kronor', async () => {
    const { screen } = await render(
      excluded(
        'no_price',
        { actualComplete: false, actual: cost(17.5) },
        { ...cash(17.5), complete: false, avgOre: null },
      ),
    )
    await expect.element(screen.getByText(m.charging_session_excluded_no_price())).toBeVisible()
    await expect.element(screen.getByText(m.charging_sessions_cost_unknown())).toBeInTheDocument()
    expect(screen.getByText(/17,50/).elements()).toHaveLength(0)
    expect(screen.getByText(/kr\/kWh/).elements()).toHaveLength(0)
  })
})

test('an estimated session marks its cost "≈" with the reason for screen readers', async () => {
  const d = excluded('no_hourly')
  d.session.estimated = true
  const { screen } = await render(d)
  const card = screen.getByRole('group', { name: m.charging_session_fig_actual() })
  await expect.element(card).toMatchTextContent(/≈\s95,13/)
  await expect.element(card).toMatchTextContent(m.charging_sessions_cost_estimated())
  // No unmarked kWh · kr/kWh line derived from the estimate.
  expect(screen.getByText(/kr\/kWh/).elements()).toHaveLength(0)
})

test('an exact session has no "≈"', async () => {
  const { screen } = await render(detail())
  expect(screen.getByText(/≈/).elements()).toHaveLength(0)
})

const mixedCash = cash(61.2, {
  noHouseDataKwh: 0,
  solarKwh: 20,
  batteryKwh: 8,
  gridKwh: 36,
  fullKwh: 36,
  avgOre: (61.2 / 56) * 100,
})

test('the hero is the cash cost; the timing below is headed as all-grid', async () => {
  const { screen } = await render(detail({ cost: mixedCash }))
  const card = screen.getByRole('group', { name: m.charging_session_fig_actual() })
  await expect.element(card).toMatchTextContent(/61,20\s?kr/)
  await expect.element(card.getByText('1,09 kr/kWh i snitt')).toBeVisible()
  const timing = screen.getByRole('region', { name: m.charging_economy_grid_only_heading() })
  await expect.element(timing.getByText(m.charging_session_verdict_ok())).toBeVisible()
  // The range bar still compares the grid-only actual.
  await expect
    .element(
      timing.getByRole('img', {
        name: m.charging_session_range_label({
          actual: formatSek(95.13, 2),
          immediate: formatSek(128.27, 2),
          cheapest: formatSek(59.44, 2),
          dearest: formatSek(130.82, 2),
        }),
      }),
    )
    .toBeInTheDocument()
  await expect
    .element(screen.getByRole('figure', { name: m.charging_session_sources_title() }))
    .toMatchTextContent(/28,0 kWh.*20,0 kWh.*8,0 kWh/)
})

test('an excluded session has the cash hero and no timing section', async () => {
  const { screen } = await render(excluded('no_hourly', {}, mixedCash))
  await expect.element(screen.getByText(/61,20/)).toBeVisible()
  expect(
    screen.getByRole('region', { name: m.charging_economy_grid_only_heading() }).elements(),
  ).toHaveLength(0)
})

test('a cash cost with a missing price is "—", even beside a complete grid-only actual', async () => {
  const { screen } = await render(detail({ cost: { ...mixedCash, complete: false } }))
  const card = screen.getByRole('group', { name: m.charging_session_fig_actual() })
  await expect.element(card.getByText(m.charging_sessions_cost_unknown())).toBeInTheDocument()
  expect(card.getByText(/61,20/).elements()).toHaveLength(0)
})

// The session's cash cost with solar on it (ADR-0023 decision 7).
const withSolar = (solar: SolarValueInput, over: { estimated?: boolean } = {}) =>
  detail({ ...over, cost: cash(95.13, solar) })

describe('value of own solar', () => {
  test('shows under the cash cost, to the öre', async () => {
    const { screen } = await render(
      withSolar({ solarPricedKwh: 6, solarUnpricedKwh: 0, solarValueSek: 4.62 }),
    )
    await expect
      .element(
        screen.getByText(m.charging_solar_value({ value: formatSek(4.62, 2) }), { exact: true }),
      )
      .toBeVisible()
  })

  test('a session without solar has no line', async () => {
    const { screen } = await render(
      withSolar({ solarPricedKwh: 0, solarUnpricedKwh: 0, solarValueSek: 0 }),
    )
    expect(screen.getByText(/Värde av egen sol/).elements()).toHaveLength(0)
  })

  test('a negative value (export would have cost money) keeps its sign', async () => {
    const { screen } = await render(
      withSolar({ solarPricedKwh: 6, solarUnpricedKwh: 0, solarValueSek: -0.37 }),
    )
    await expect.element(screen.getByText(/Värde av egen sol: −0,37\skr/)).toBeVisible()
  })

  test('an estimated session marks the value "≈", with the reason for screen readers', async () => {
    const { screen } = await render(
      withSolar(
        { solarPricedKwh: 6, solarUnpricedKwh: 0, solarValueSek: 4.62 },
        { estimated: true },
      ),
    )
    const line = screen.getByText(/Värde av egen sol: ≈\s4,62\skr/)
    await expect.element(line).toBeVisible()
    // The hero's own Estimated also has this sr-only text, so check inside the solar line itself.
    expect(line.element().textContent).toContain(`(${m.charging_sessions_cost_estimated()})`)
  })

  test('an estimated session with partly unpriced solar says "minst", not "≈ minst"', async () => {
    const { screen } = await render(
      withSolar(
        { solarPricedKwh: 4, solarUnpricedKwh: 2, solarValueSek: 4.62 },
        { estimated: true },
      ),
    )
    await expect
      .element(
        screen.getByText(
          m.charging_solar_value({ value: m.charging_cost_min({ total: formatSek(4.62, 2) }) }),
          { exact: true },
        ),
      )
      .toBeVisible()
  })

  test('solar with no spot price at all reads "okänt"', async () => {
    const { screen } = await render(
      withSolar({ solarPricedKwh: 0, solarUnpricedKwh: 6, solarValueSek: 0 }),
    )
    await expect
      .element(screen.getByText(m.charging_solar_value_unknown(), { exact: true }))
      .toBeVisible()
  })

  test('an estimated session with unknown solar says "okänt", with no "≈" or estimate reason', async () => {
    const { screen } = await render(
      withSolar({ solarPricedKwh: 0, solarUnpricedKwh: 6, solarValueSek: 0 }, { estimated: true }),
    )
    const line = screen.getByText(m.charging_solar_value_unknown(), { exact: true })
    await expect.element(line).toBeVisible()
    expect(line.element().textContent).not.toContain('≈')
    expect(line.element().textContent).not.toContain(m.charging_sessions_cost_estimated())
  })

  test('the line shows even when the cash cost is unknown', async () => {
    const { screen } = await render(
      detail({
        cost: cash(0, {
          fullKwh: 0,
          noPriceKwh: 56,
          avgOre: null,
          complete: false,
          solarPricedKwh: 6,
          solarUnpricedKwh: 0,
          solarValueSek: 4.62,
        }),
      }),
    )
    await expect
      .element(
        screen.getByText(m.charging_solar_value({ value: formatSek(4.62, 2) }), { exact: true }),
      )
      .toBeVisible()
  })
})
