import { expect, test } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { DisponeringslistaTable } from '~/components/season/DisponeringslistaTable'
import { buildSchedules } from '~/lib/services/season/logic'
import { type ShareCode, WEEKS_PER_SHARE } from '~/lib/shares/codes'
import { m } from '~/paraglide/messages'
import { ANCHOR_ERA } from '~test/fixtures/season'

// The browser test env loads no Tailwind CSS, so the component's responsive
// classes (`hidden lg:block` / `lg:hidden`) have no effect here: BOTH layouts
// are in the DOM at every viewport, and all assertions below are structural
// (selectors scoped to markup only one layout produces). The page.viewport
// calls document each test's intended breakpoint and become load-bearing if
// the harness ever loads the app CSS; real responsive visibility is verified
// live in the browser instead.

const y2026 = buildSchedules([ANCHOR_ERA], 2026).find((s) => s.year === 2026)
if (!y2026) throw new Error('fixture: 2026 schedule missing')

const NO_SHARES: ReadonlySet<ShareCode> = new Set()

// The wide layout merges each share into one cell spanning WEEKS_PER_SHARE
// week-columns; derive the selector from the constant so retuning it can't
// silently zero out these queries.
const SHARE_CELL_SELECTOR = `td[colspan="${WEEKS_PER_SHARE}"]`

test('wide layout renders one merged cell per share', async () => {
  await page.viewport(1280, 800)
  const screen = await render(
    <DisponeringslistaTable schedules={[y2026]} currentYear={2026} ownedShareCodes={NO_SHARES} />,
  )
  const shareCells = [...screen.container.querySelectorAll(SHARE_CELL_SELECTOR)]
  expect(shareCells.map((c) => c.textContent)).toEqual([
    'D',
    'E',
    'F',
    'G',
    'H',
    'I',
    'J',
    'A',
    'B',
    'C',
  ])
  // The week-number header row (2nd table row) still has all 20 per-week
  // columns. (Structural query, not getByText — the mobile layout's week
  // texts would make text locators ambiguous.)
  const weekRow = screen.container.querySelectorAll('tr')[1]
  expect(weekRow?.querySelectorAll('td')).toHaveLength(20)
})

test('month divider stops above a straddling block', async () => {
  await page.viewport(1280, 800)
  const screen = await render(
    <DisponeringslistaTable schedules={[y2026]} currentYear={2026} ownedShareCodes={NO_SHARES} />,
  )
  const cells = [...screen.container.querySelectorAll(SHARE_CELL_SELECTOR)]
  const cellF = cells.find((c) => c.textContent === 'F') // 25–26 ends at Jun's last week
  const cellI = cells.find((c) => c.textContent === 'I') // 31–32 straddles Jul/Aug
  expect(cellF?.className).toContain('border-r')
  expect(cellI?.className).not.toContain('border-r')
})

test('owned share renders one merged cell with a range label', async () => {
  await page.viewport(1280, 800)
  const screen = await render(
    <DisponeringslistaTable
      schedules={[y2026]}
      currentYear={2026}
      ownedShareCodes={new Set<ShareCode>(['C'])}
    />,
  )
  // C owns weeks 39–40 in 2026: a single cell labelled with the whole range
  // and the share letter (the label replaces the cell text for AT).
  await expect
    .element(screen.getByLabelText(m.season_my_weeks({ from: 39, to: 40, share: 'C' })))
    .toBeVisible()
})

test('wide layout draws the owned ring on the merged cell', async () => {
  await page.viewport(1280, 800)
  const screen = await render(
    <DisponeringslistaTable
      schedules={[y2026]}
      currentYear={2026}
      ownedShareCodes={new Set<ShareCode>(['C'])}
    />,
  )
  // The owned cell is the ONLY <td> carrying an aria-label (desktop marks
  // ownership with the label; mobile uses an sr-only span instead), so this
  // pins the desktop cell without depending on the colspan value.
  const ownedCell = screen.container.querySelector('td[aria-label]')
  expect(ownedCell?.textContent).toBe('C')
  // OWNED_RING in the component; cn() (clsx + twMerge) preserves class order,
  // so the trio stays contiguous.
  expect(ownedCell?.className).toContain('ring-2 ring-inset ring-foreground')
})

test('mobile layout lists one row per block with a week range', async () => {
  await page.viewport(390, 844)
  const screen = await render(
    <DisponeringslistaTable schedules={[y2026]} currentYear={2026} ownedShareCodes={NO_SHARES} />,
  )
  await expect.element(screen.getByText('21–22')).toBeVisible()
  await expect.element(screen.getByText('39–40')).toBeVisible()
})

test('mobile layout marks the owned row with the ring and an sr-only label', async () => {
  await page.viewport(390, 844)
  const screen = await render(
    <DisponeringslistaTable
      schedules={[y2026]}
      currentYear={2026}
      ownedShareCodes={new Set<ShareCode>(['C'])}
    />,
  )
  // The sr-only ownership label is mobile-only (desktop uses an aria-label),
  // so it unambiguously locates the owned row.
  const srLabel = screen.container.querySelector('span.sr-only')
  expect(srLabel?.textContent).toBe(m.season_my_weeks({ from: 39, to: 40, share: 'C' }))
  // Its enclosing row carries the owned ring, and the two visible spans are
  // aria-hidden so AT doesn't announce the row twice.
  const ownedRow = srLabel?.closest('div')
  expect(ownedRow?.className).toContain('ring-2 ring-inset ring-foreground')
  expect(ownedRow?.querySelectorAll('[aria-hidden="true"]')).toHaveLength(2)
})

test('mobile layout skips a month heading that only holds a block tail', async () => {
  await page.viewport(390, 844)
  const screen = await render(
    <DisponeringslistaTable schedules={[y2026]} currentYear={2026} ownedShareCodes={NO_SHARES} />,
  )
  // 2026's Okt band is only week 40 — the tail of the 39–40 block, whose row
  // lives under Sep. Month headings are the mobile layout's only <h3>s; the
  // exact sequence pins the block grouping (and the Okt skip) without
  // depending on CSS visibility (the browser test env loads no Tailwind).
  const headings = [...screen.container.querySelectorAll('h3')].map((h) => h.textContent)
  expect(headings).toEqual([
    m.season_month_may(),
    m.season_month_jun(),
    m.season_month_jul(),
    m.season_month_aug(),
    m.season_month_sep(),
  ])
})

test('mobile layout files a forward-straddling block under its start month', async () => {
  await page.viewport(390, 844)
  const screen = await render(
    <DisponeringslistaTable schedules={[y2026]} currentYear={2026} ownedShareCodes={NO_SHARES} />,
  )
  // 2026 block I spans weeks 31 (Jul) / 32 (Aug); its row belongs under Jul,
  // the block's START month, not the month its tail bleeds into. MonthSections
  // are the mobile layout's only <section>s with a direct <h3>, so scope the
  // range text to the section whose heading is Jul (structural — no CSS here).
  const julSection = [...screen.container.querySelectorAll('section')].find(
    (s) => s.querySelector(':scope > h3')?.textContent === m.season_month_jul(),
  )
  expect(julSection?.textContent).toContain('31–32')
})

test('renders years newest-first from a chronological schedule', async () => {
  await page.viewport(1280, 800)
  // buildSchedules returns chronological order; the component owns the
  // newest-first display decision (and the isFirstYear heavy-border logic).
  const chronological = buildSchedules([ANCHOR_ERA], 2026) // [2024 .. 2027]
  const screen = await render(
    <DisponeringslistaTable
      schedules={chronological}
      currentYear={2026}
      ownedShareCodes={NO_SHARES}
    />,
  )
  const yearHeaders = [...screen.container.querySelectorAll('th[rowspan="3"]')]
  expect(yearHeaders.map((h) => h.textContent)).toEqual(['2027', '2026', '2025', '2024'])
})

test('current-year highlight follows the currentYear prop, not the clock', async () => {
  await page.viewport(1280, 800)
  const current = await render(
    <DisponeringslistaTable schedules={[y2026]} currentYear={2026} ownedShareCodes={NO_SHARES} />,
  )
  const currentCells = [...current.container.querySelectorAll(SHARE_CELL_SELECTOR)]
  expect(currentCells[0]?.className).toContain('font-bold')
  expect(currentCells[0]?.className).not.toContain('text-muted-foreground')

  const other = await render(
    <DisponeringslistaTable schedules={[y2026]} currentYear={2025} ownedShareCodes={NO_SHARES} />,
  )
  const otherCells = [...other.container.querySelectorAll(SHARE_CELL_SELECTOR)]
  expect(otherCells[0]?.className).toContain('text-muted-foreground')
})
