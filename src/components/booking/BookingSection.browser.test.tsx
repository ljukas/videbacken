import { expect, test } from 'vitest'
import { page } from 'vitest/browser'
import { orpc } from '~/lib/orpc/client'
import { buildSuggestion, extraBlocksForSeason, type Slot } from '~/lib/services/booking/logic'
import { monthBandsForRange, shareBlocksForSeason } from '~/lib/services/season/logic'
import type { ShareCode } from '~/lib/shares/codes'
import { m } from '~/paraglide/messages'
import { makeTestQueryClient, renderWithProviders } from '~test/browser/render'
import { BookingSection } from './BookingSection'
import type { BookingData } from './stripModel'

// 2027 under the seeded era (2024/21/J): startShare A — rotation letters are
// A..J at weeks 21..40, extras 19–20 and 41–42. Fixed future year keeps the
// ISO month math deterministic regardless of wall clock.
const SEASON_2027 = { startWeek: 21, startShare: 'A' } as const
const EXTRAS = extraBlocksForSeason(SEASON_2027)
const ALL_CODES = [...'ABCDEFGHIJ'] as Array<ShareCode>
const NO_SHARES: ReadonlySet<ShareCode> = new Set()

function makeData(overrides: Partial<BookingData> = {}): BookingData {
  return {
    year: 2027,
    lockedAt: null,
    blocks: {
      early: EXTRAS.early,
      rotation: shareBlocksForSeason(SEASON_2027),
      late: EXTRAS.late,
    },
    monthBands: monthBandsForRange({
      year: 2027,
      firstWeek: EXTRAS.early.firstWeek,
      lastWeek: EXTRAS.late.lastWeek,
    }),
    wishes: [],
    assignedShares: ALL_CODES,
    lockedSchedule: null,
    ...overrides,
  }
}

test('renders 12 desktop block cells: two extras around ten rotation letters', async () => {
  await page.viewport(1280, 800)
  const { screen } = await renderWithProviders(
    <BookingSection data={makeData()} isAdmin={false} ownedShareCodes={NO_SHARES} />,
  )
  const cells = [...screen.container.querySelectorAll('td[colspan="2"] button')]
  expect(cells.map((c) => c.textContent)).toEqual([
    '–',
    'A',
    'B',
    'C',
    'D',
    'E',
    'F',
    'G',
    'H',
    'I',
    'J',
    '–',
  ])
  // A shareless viewer gets a view-only strip: every block disabled.
  expect(cells.every((c) => c.hasAttribute('disabled'))).toBe(true)
})

test('a wished block is pressed for the acting share and stacks wish chips', async () => {
  await page.viewport(1280, 800)
  const data = makeData({
    wishes: [
      { id: 'w1', shareCode: 'C', targetKind: 'share', targetShare: 'A' },
      { id: 'w2', shareCode: 'D', targetKind: 'share', targetShare: 'A' },
    ],
  })
  const { screen } = await renderWithProviders(
    <BookingSection data={data} isAdmin={false} ownedShareCodes={new Set<ShareCode>(['C'])} />,
  )
  const pressed = [
    ...screen.container.querySelectorAll('td[colspan="2"] button[aria-pressed="true"]'),
  ]
  expect(pressed).toHaveLength(1)
  // A's block (21–22): holder letter A plus chips C and D.
  expect(pressed[0]?.textContent).toBe('ACD')
})

test("the acting share's own block is not wishable", async () => {
  await page.viewport(1280, 800)
  const { screen } = await renderWithProviders(
    <BookingSection
      data={makeData()}
      isAdmin={false}
      ownedShareCodes={new Set<ShareCode>(['A'])}
    />,
  )
  const ownLabel = m.season_my_weeks({ from: 21, to: 22, share: 'A' })
  const own = [...screen.container.querySelectorAll(`button[aria-label="${ownLabel}"]`)]
  expect(own.length).toBeGreaterThan(0) // desktop + mobile render
  expect(own.every((b) => b.hasAttribute('disabled'))).toBe(true)
  // Other blocks stay wishable.
  const other = [
    ...screen.container.querySelectorAll(
      `button[aria-label="${m.booking_wish_block_aria({ share: 'B', from: 23, to: 24 })}"]`,
    ),
  ]
  expect(other.every((b) => !b.hasAttribute('disabled'))).toBe(true)
})

test('multi-share owners get the acting-share selector', async () => {
  const { screen } = await renderWithProviders(
    <BookingSection
      data={makeData()}
      isAdmin={false}
      ownedShareCodes={new Set<ShareCode>(['A', 'B'])}
    />,
  )
  await expect.element(screen.getByText(m.booking_wish_as())).toBeVisible()
})

test('single-share owners get no selector', async () => {
  const { screen } = await renderWithProviders(
    <BookingSection
      data={makeData()}
      isAdmin={false}
      ownedShareCodes={new Set<ShareCode>(['A'])}
    />,
  )
  expect(screen.container.textContent).not.toContain(m.booking_wish_as())
})

test('a locked round renders the final schedule, hides wishes, and summarizes my weeks', async () => {
  await page.viewport(1280, 800)
  // C traded to A's block and won the early extra; A moved to C's block.
  const slots: Array<Slot> = [
    { ...EXTRAS.early, kind: 'extra', holder: 'C' },
    ...shareBlocksForSeason(SEASON_2027).map((b) => ({
      firstWeek: b.firstWeek,
      lastWeek: b.lastWeek,
      kind: 'rotation' as const,
      holder: (b.shareCode === 'A' ? 'C' : b.shareCode === 'C' ? 'A' : b.shareCode) as ShareCode,
    })),
    { ...EXTRAS.late, kind: 'extra', holder: null },
  ]
  const data = makeData({
    lockedAt: new Date('2027-03-01T12:00:00Z'),
    lockedSchedule: slots,
    wishes: [{ id: 'w1', shareCode: 'C', targetKind: 'share', targetShare: 'A' }],
  })
  const { screen } = await renderWithProviders(
    <BookingSection data={data} isAdmin={false} ownedShareCodes={new Set<ShareCode>(['C'])} />,
  )
  const cells = [...screen.container.querySelectorAll('td[colspan="2"] button')]
  expect(cells.map((c) => c.textContent)).toEqual([
    'C',
    'C',
    'B',
    'A',
    'D',
    'E',
    'F',
    'G',
    'H',
    'I',
    'J',
    '–',
  ])
  // Wish chips and toggling are gone once locked.
  expect(screen.container.querySelectorAll('button[aria-pressed]')).toHaveLength(0)
  await expect
    .element(screen.getByText(m.booking_locked_my_weeks({ year: 2027, weeks: '19–20 + 21–22' })))
    .toBeVisible()
})

test('admins see arrange and lock controls on an open round; owners do not', async () => {
  const admin = await renderWithProviders(
    <BookingSection data={makeData()} isAdmin ownedShareCodes={NO_SHARES} />,
  )
  await expect
    .element(admin.screen.getByRole('button', { name: m.booking_arrange() }))
    .toBeVisible()
  await expect.element(admin.screen.getByRole('button', { name: m.booking_lock() })).toBeVisible()
  const owner = await renderWithProviders(
    <BookingSection data={makeData()} isAdmin={false} ownedShareCodes={NO_SHARES} />,
  )
  expect(owner.screen.container.textContent).not.toContain(m.booking_arrange())
})

test('arrange mode renders the seeded draft, suggestion panel and draft chip', async () => {
  await page.viewport(1280, 800)
  const wishes = [
    { id: 'w1', shareCode: 'C' as const, targetKind: 'share' as const, targetShare: 'A' as const },
    { id: 'w2', shareCode: 'A' as const, targetKind: 'share' as const, targetShare: 'C' as const },
    // Unreciprocated: B wants A's weeks but nobody wants B's — no cycle can
    // move B, so its wish must surface as explicitly not fulfilled.
    { id: 'w3', shareCode: 'B' as const, targetKind: 'share' as const, targetShare: 'A' as const },
  ]
  const suggestion = buildSuggestion({
    season: SEASON_2027,
    wishes,
    assignedShares: new Set(ALL_CODES),
  })
  const queryClient = makeTestQueryClient()
  queryClient.setQueryData(orpc.booking.getDraft.queryKey(), {
    year: 2027,
    draftExists: true,
    slots: suggestion.slots,
    suggestion,
  })
  const { screen } = await renderWithProviders(
    <BookingSection data={makeData({ wishes })} isAdmin ownedShareCodes={NO_SHARES} />,
    { queryClient },
  )
  await screen.getByRole('button', { name: m.booking_arrange() }).click()
  await expect
    .element(screen.getByText(m.booking_suggestion_summary({ satisfied: 2, total: 3 })))
    .toBeVisible()
  await expect.element(screen.getByText('A ↔ C')).toBeVisible()
  // Per-share wish status: A and C are fulfilled, B is explicitly not —
  // its chip names what B wished for.
  await expect.element(screen.getByText('B → A')).toBeVisible()
  expect(screen.container.textContent).toContain(m.booking_suggestion_wish_met_sr({ share: 'A' }))
  expect(screen.container.textContent).toContain(m.booking_suggestion_wish_met_sr({ share: 'C' }))
  expect(screen.container.textContent).toContain(m.booking_suggestion_wish_unmet_sr({ share: 'B' }))
  await expect.element(screen.getByText(m.booking_draft_chip())).toBeVisible()
  // The strip now shows the draft's holders: C on A's nominal block (21–22).
  const cells = [...screen.container.querySelectorAll('td[colspan="2"] button')]
  expect(cells[1]?.textContent).toContain('C')
})

test('opening an extra-block popover in arrange mode mounts exactly one panel', async () => {
  // The harness renders BOTH responsive layouts (strip + cards, CSS-hidden).
  // Radix portals PopoverContent to document.body, escaping the hidden
  // wrapper — so a popover open-state keyed only by week opens both layouts'
  // popovers at once. Clicking the visible (desktop) strip block must open
  // exactly one panel, not a second detached copy from the hidden layout.
  await page.viewport(1280, 800)
  const suggestion = buildSuggestion({
    season: SEASON_2027,
    wishes: [],
    assignedShares: new Set(ALL_CODES),
  })
  const queryClient = makeTestQueryClient()
  queryClient.setQueryData(orpc.booking.getDraft.queryKey(), {
    year: 2027,
    draftExists: true,
    slots: suggestion.slots,
    suggestion,
  })
  const { screen } = await renderWithProviders(
    <BookingSection data={makeData()} isAdmin ownedShareCodes={NO_SHARES} />,
    { queryClient },
  )
  await screen.getByRole('button', { name: m.booking_arrange() }).click()
  // Wait for the lazy draft to resolve so the extra block is a popover trigger.
  await expect.element(screen.getByText(m.booking_draft_chip())).toBeVisible()
  // The early extra (19–20) is popover-eligible. The harness ships no CSS, so
  // both layouts render (the strip's trigger is first in the DOM); click it
  // and assert only its own popover mounts — not the hidden cards' copy too.
  const label = m.booking_arrange_block_aria({
    from: EXTRAS.early.firstWeek,
    to: EXTRAS.early.lastWeek,
  })
  await screen.getByRole('button', { name: label }).first().click()
  await expect.poll(() => document.querySelectorAll('[data-slot="popover-content"]').length).toBe(1)
})

test('block clicks are ignored while the arrange draft is still loading', async () => {
  await page.viewport(1280, 800)
  // Admin who ALSO owns a share, so the owner wish path is live. Seed
  // getActive with the SAME object rendered as the `data` prop so cache and
  // render agree; seed NO getDraft data — entering arrange mode enables the
  // lazy draft query but it never resolves in the harness, so `draft` stays
  // null: the race window, held open deterministically.
  const data = makeData()
  const queryClient = makeTestQueryClient()
  queryClient.setQueryData(orpc.booking.getActive.queryKey(), data)
  const { screen } = await renderWithProviders(
    <BookingSection data={data} isAdmin ownedShareCodes={new Set<ShareCode>(['C'])} />,
    { queryClient },
  )
  await screen.getByRole('button', { name: m.booking_arrange() }).click()
  const bBlock = screen.container.querySelector<HTMLButtonElement>(
    `td[colspan="2"] button[aria-label="${m.booking_wish_block_aria({ share: 'B', from: 23, to: 24 })}"]`,
  )
  expect(bBlock).not.toBeNull()
  if (bBlock) await page.elementLocator(bBlock).click()
  // A fall-through to the owner branch would optimistically append C's wish
  // to the seeded getActive cache; the guard leaves it untouched.
  expect(queryClient.getQueryData(orpc.booking.getActive.queryKey())?.wishes).toEqual([])
})

test('a locked round gives admins an unlock menu behind the status chip', async () => {
  const data = makeData({
    lockedAt: new Date('2027-03-01T12:00:00Z'),
    lockedSchedule: [
      { ...EXTRAS.early, kind: 'extra', holder: null },
      ...shareBlocksForSeason(SEASON_2027).map((b) => ({
        firstWeek: b.firstWeek,
        lastWeek: b.lastWeek,
        kind: 'rotation' as const,
        holder: b.shareCode,
      })),
      { ...EXTRAS.late, kind: 'extra', holder: null },
    ],
  })
  const { screen } = await renderWithProviders(
    <BookingSection data={data} isAdmin ownedShareCodes={NO_SHARES} />,
  )
  await screen
    .getByRole('button', { name: new RegExp(m.booking_status_locked({ date: '' }).trim()) })
    .click()
  await expect.element(screen.getByRole('menuitem', { name: m.booking_unlock() })).toBeVisible()
})
