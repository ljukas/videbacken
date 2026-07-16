# Plan 05 — Owner UI: BookingSection, strip, cards, wish toggles

> Part of [season-booking](./README.md). Requires plans 01–04 committed. Steps use checkbox syntax for tracking.

**Goal:** The owner-facing booking section on `/`: a 24-week strip (desktop table / mobile cards) above the Disponeringslista showing nominal blocks + wish chips while open and the final schedule when locked, with optimistic wish toggling. Admin arrange/lock controls come in plan 06 — this plan leaves marked mount points for them.

**Design stance (ADR-0020 §UI):** reuse the Disponeringslista's visual grammar (month bands, week row, `shareBackgroundClass` pastels, `OWNED_RING`), Linear-lifted tinted chips + avatar-stack wish chips, 120–160 ms reduced-motion-aware transitions. *The group expects visual refinement during Phase-6 browser verification — the class strings below are the starting composition, not pixel law; behavior and structure (selectors, aria) are binding.*

**Key semantics (binding):**
- Wish targets are **nominal**: "D's weeks" means the block where D sits in the nominal rotation. Chips therefore always render at fixed week positions, whatever a draft/lock did to holders.
- A block is un-wishable only when locked, when the viewer holds no share, or when `target.targetShare === actingShare` (README locked decision 9).
- Browser tests are structural (the harness loads no Tailwind CSS and both layouts render simultaneously — scope selectors, don't assert visibility of responsive variants). Interactive mutation flows are verified live in plan 07 (no MSW in the harness).

---

### Task 1: extract shared calendar constants

**Files:**
- Create: `src/components/season/calendar.ts`
- Modify: `src/components/season/DisponeringslistaTable.tsx`

**Interfaces:**
- Produces: `MONTH_LABELS` (month index → Paraglide message *function*) and `OWNED_RING` (`'ring-2 ring-inset ring-foreground'`) importable by the booking components.

- [ ] **Step 1: Move the constants**

Create `src/components/season/calendar.ts` and **move** (cut, verbatim, including their comments) the `MONTH_LABELS` and `OWNED_RING` constants from `DisponeringslistaTable.tsx` into it, adding `export` to each. The file starts with whatever imports the moved code needs (`import { m } from '~/paraglide/messages'`).

In `DisponeringslistaTable.tsx`, add:

```ts
import { MONTH_LABELS, OWNED_RING } from './calendar'
```

- [ ] **Step 2: Verify nothing changed**

Run: `pnpm vitest run --project browser src/components/season/DisponeringslistaTable.browser.test.tsx`
Expected: PASS — pure move.

- [ ] **Step 3: Commit**

```bash
git add src/components/season/calendar.ts src/components/season/DisponeringslistaTable.tsx
git commit --no-gpg-sign -m "refactor(season): share month labels and owned-ring constants"
```

---

### Task 2: owner i18n keys

**Files:**
- Modify: `messages/sv.json`, `messages/en.json`

**Interfaces:**
- Produces: the `m.booking_*` functions used by Tasks 3–4 (exact names below).

- [ ] **Step 1: Add the keys**

Into the existing `booking_*` block (keep alphabetical), `messages/sv.json`:

```json
  "booking_helper_owner": "Klicka på ett block du vill byta till",
  "booking_locked_my_weeks": "Dina veckor {year}: {weeks}",
  "booking_status_locked": "Låst {date}",
  "booking_status_open": "Öppen för önskemål",
  "booking_title": "Bokning {year}",
  "booking_wish_as": "Önskar som:",
  "booking_wish_block_aria": "Önska byte med {share}, veckor {from}–{to}",
  "booking_wish_extra_aria": "Önska extraveckor {from}–{to}",
```

`messages/en.json`, same position:

```json
  "booking_helper_owner": "Click a block you'd like to trade to",
  "booking_locked_my_weeks": "Your weeks {year}: {weeks}",
  "booking_status_locked": "Locked {date}",
  "booking_status_open": "Open for wishes",
  "booking_title": "Booking {year}",
  "booking_wish_as": "Wishing as:",
  "booking_wish_block_aria": "Wish to trade with {share}, weeks {from}–{to}",
  "booking_wish_extra_aria": "Wish for extra weeks {from}–{to}",
```

Run: `pnpm i18n:compile`
Expected: succeeds.

- [ ] **Step 2: Commit**

```bash
git add messages/sv.json messages/en.json
git commit --no-gpg-sign -m "feat(i18n): owner-facing booking messages"
```

---

### Task 3: strip view-model + presentational components

**Files:**
- Create: `src/components/booking/stripModel.ts`
- Create: `src/components/booking/WishChips.tsx`
- Create: `src/components/booking/BookingStrip.tsx`
- Create: `src/components/booking/BookingCards.tsx`

**Interfaces:**
- Consumes: `MonthBand`, `ShareBlock` types from `~/lib/services/season/logic`; `BookingTarget`, `Slot` from `~/lib/services/booking/logic`; `shareBackgroundClass` from `~/lib/shares/colors`; `MONTH_LABELS`, `OWNED_RING` from `~/components/season/calendar`; `WEEKS_PER_SHARE` from `~/lib/shares/codes`.
- Produces (Task 4 and plan 06 rely on these exact shapes):

  ```ts
  export type BookingWish = { id: string; shareCode: ShareCode; targetKind: BookingTarget; targetShare: ShareCode | null }
  export type BookingData = {
    year: number
    lockedAt: Date | null
    blocks: {
      early: { firstWeek: number; lastWeek: number }
      rotation: Array<ShareBlock>
      late: { firstWeek: number; lastWeek: number }
    }
    monthBands: Array<MonthBand>
    wishes: Array<BookingWish>
    assignedShares: Array<ShareCode>
    lockedSchedule: Array<Slot> | null
  }
  export type WishTarget = { targetKind: BookingTarget; targetShare: ShareCode | null }
  export type StripBlock = {
    firstWeek: number; lastWeek: number; kind: 'rotation' | 'extra'
    holder: ShareCode | null; holderAssigned: boolean; isMine: boolean
    wishes: Array<ShareCode>; myWish: boolean; target: WishTarget
  }
  export function buildStripBlocks(data: BookingData, actingShare: ShareCode | null, ownedShareCodes: ReadonlySet<ShareCode>, slots: Array<Slot> | null): Array<StripBlock>
  export function blockAriaLabel(block: StripBlock, input: { showWishes: boolean; actingShare: ShareCode | null }): string | undefined
  ```

  ```ts
  // Shared props of BookingStrip (desktop table) and BookingCards (mobile):
  type StripViewProps = {
    year: number                       // BookingCards only (card header)
    monthBands: Array<MonthBand>
    blocks: Array<StripBlock>
    actingShare: ShareCode | null
    showWishes: boolean                // false once locked
    interactive: boolean               // false when locked or shareless viewer
    onBlockClick: (block: StripBlock) => void
    selectedWeek: number | null        // plan 06 arrange selection; pass null
  }
  ```

- [ ] **Step 1: Write `stripModel.ts`**

```ts
import type { BookingTarget, Slot } from '~/lib/services/booking/logic'
import type { MonthBand, ShareBlock } from '~/lib/services/season/logic'
import type { ShareCode } from '~/lib/shares/codes'
import { m } from '~/paraglide/messages'

// Client view-model for the booking strip. Pure — BookingSection derives it
// once and hands it to both layouts (ADR-0020 §UI).

export type BookingWish = {
  id: string
  shareCode: ShareCode
  targetKind: BookingTarget
  targetShare: ShareCode | null
}

// The orpc.booking.getActive payload shape (structural — server source of
// truth is procedures/booking.ts).
export type BookingData = {
  year: number
  lockedAt: Date | null
  blocks: {
    early: { firstWeek: number; lastWeek: number }
    rotation: Array<ShareBlock>
    late: { firstWeek: number; lastWeek: number }
  }
  monthBands: Array<MonthBand>
  wishes: Array<BookingWish>
  assignedShares: Array<ShareCode>
  lockedSchedule: Array<Slot> | null
}

export type WishTarget = { targetKind: BookingTarget; targetShare: ShareCode | null }

export type StripBlock = {
  firstWeek: number
  lastWeek: number
  kind: 'rotation' | 'extra'
  // The letter the cell renders: nominal share (open round), slot holder
  // (arrange preview / locked), or null (unheld extra).
  holder: ShareCode | null
  holderAssigned: boolean
  isMine: boolean
  // Wish chips are anchored to NOMINAL positions — "D's weeks" means the
  // block D holds in the nominal rotation, whatever a draft did to holders.
  wishes: Array<ShareCode>
  myWish: boolean
  target: WishTarget
}

export function buildStripBlocks(
  data: BookingData,
  actingShare: ShareCode | null,
  ownedShareCodes: ReadonlySet<ShareCode>,
  // Non-null renders these concrete slots' holders (locked schedule or the
  // admin draft) instead of the nominal rotation.
  slots: Array<Slot> | null,
): Array<StripBlock> {
  const assigned = new Set(data.assignedShares)
  const nominalByWeek = new Map(data.blocks.rotation.map((b) => [b.firstWeek, b.shareCode]))
  const holderByWeek = slots ? new Map(slots.map((s) => [s.firstWeek, s.holder])) : null

  const toBlock = (input: {
    firstWeek: number
    lastWeek: number
    kind: 'rotation' | 'extra'
    target: WishTarget
  }): StripBlock => {
    const holder = holderByWeek
      ? (holderByWeek.get(input.firstWeek) ?? null)
      : input.kind === 'rotation'
        ? (nominalByWeek.get(input.firstWeek) ?? null)
        : null
    const wishes = data.wishes
      .filter(
        (w) =>
          w.targetKind === input.target.targetKind && w.targetShare === input.target.targetShare,
      )
      .map((w) => w.shareCode)
    return {
      ...input,
      holder,
      holderAssigned: holder !== null && assigned.has(holder),
      isMine: holder !== null && ownedShareCodes.has(holder),
      wishes,
      myWish: actingShare !== null && wishes.includes(actingShare),
    }
  }

  return [
    toBlock({
      ...data.blocks.early,
      kind: 'extra',
      target: { targetKind: 'extra_early', targetShare: null },
    }),
    ...data.blocks.rotation.map((b) =>
      toBlock({
        firstWeek: b.firstWeek,
        lastWeek: b.lastWeek,
        kind: 'rotation',
        target: { targetKind: 'share', targetShare: b.shareCode },
      }),
    ),
    toBlock({
      ...data.blocks.late,
      kind: 'extra',
      target: { targetKind: 'extra_late', targetShare: null },
    }),
  ]
}

// The block button's accessible name. While wishable it announces the
// action; otherwise (locked, or the acting share's own block) it announces
// ownership like the Disponeringslista does.
export function blockAriaLabel(
  block: StripBlock,
  input: { showWishes: boolean; actingShare: ShareCode | null },
): string | undefined {
  const ownTarget = input.actingShare !== null && block.target.targetShare === input.actingShare
  if (input.showWishes && !ownTarget) {
    return block.target.targetKind === 'share' && block.target.targetShare
      ? m.booking_wish_block_aria({
          share: block.target.targetShare,
          from: block.firstWeek,
          to: block.lastWeek,
        })
      : m.booking_wish_extra_aria({ from: block.firstWeek, to: block.lastWeek })
  }
  return block.isMine && block.holder
    ? m.season_my_weeks({ from: block.firstWeek, to: block.lastWeek, share: block.holder })
    : undefined
}
```

- [ ] **Step 2: Write `WishChips.tsx`**

```tsx
import type { ShareCode } from '~/lib/shares/codes'
import { shareBackgroundClass } from '~/lib/shares/colors'
import { cn } from '~/lib/utils'

type WishChipsProps = {
  wishes: Array<ShareCode>
  actingShare: ShareCode | null
}

// Per-block stack of share-letter chips showing who wished for it; the
// acting share's own chip is brand-accented (ADR-0020 §UI). Decorative for
// AT — the block button's aria-pressed/label carries the state. The min-h
// placeholder keeps block heights even across cells without chips.
export function WishChips({ wishes, actingShare }: WishChipsProps) {
  return (
    <span className="flex min-h-4 flex-wrap items-center justify-center gap-0.5" aria-hidden>
      {wishes.map((code) => (
        <span
          key={code}
          className={cn(
            'flex size-4 items-center justify-center rounded-full font-medium text-[10px] leading-none',
            shareBackgroundClass[code],
            code === actingShare && 'ring-1 ring-brand',
          )}
        >
          {code}
        </span>
      ))}
    </span>
  )
}
```

- [ ] **Step 3: Write `BookingStrip.tsx`** (desktop, ≥lg)

The month-band `<tr>` and week `<tr>` markup is copied from `DisponeringslistaTable`'s `WideLayout` minus the year `<th>` (single-year strip); keep the two files visually in sync when polishing.

```tsx
import type { MonthBand } from '~/lib/services/season/logic'
import { WEEKS_PER_SHARE, type ShareCode } from '~/lib/shares/codes'
import { shareBackgroundClass } from '~/lib/shares/colors'
import { cn } from '~/lib/utils'
import { MONTH_LABELS, OWNED_RING } from '~/components/season/calendar'
import { blockAriaLabel, type StripBlock } from './stripModel'
import { WishChips } from './WishChips'

type BookingStripProps = {
  monthBands: Array<MonthBand>
  blocks: Array<StripBlock>
  actingShare: ShareCode | null
  showWishes: boolean
  interactive: boolean
  onBlockClick: (block: StripBlock) => void
  selectedWeek: number | null
}

export function BookingStrip({
  monthBands,
  blocks,
  actingShare,
  showWishes,
  interactive,
  onBlockClick,
  selectedWeek,
}: BookingStripProps) {
  const monthEndWeeks = new Set(monthBands.slice(0, -1).map((b) => b.lastWeek))
  const lastBandIdx = monthBands.length - 1
  return (
    <div className="hidden overflow-auto rounded-lg border bg-surface-raised lg:-mx-4 lg:block">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-muted-foreground text-xs uppercase tracking-wider">
            {monthBands.map((band, i) => (
              <th
                key={band.firstWeek}
                colSpan={band.span}
                className={cn(
                  'bg-muted py-1 text-center font-semibold',
                  i < lastBandIdx && 'border-r',
                )}
              >
                {MONTH_LABELS[band.month]?.()}
              </th>
            ))}
          </tr>
          <tr className="text-muted-foreground text-xs">
            {monthBands.flatMap((band) =>
              Array.from({ length: band.span }, (_, i) => {
                const week = band.firstWeek + i
                return (
                  <td
                    key={week}
                    className={cn(
                      'border-b bg-muted px-1 py-0.5 text-center font-normal tabular-nums',
                      monthEndWeeks.has(week) && 'border-r',
                    )}
                  >
                    {week}
                  </td>
                )
              }),
            )}
          </tr>
        </thead>
        <tbody>
          <tr>
            {blocks.map((block) => {
              const ownTarget = actingShare !== null && block.target.targetShare === actingShare
              const disabled = !interactive || ownTarget
              return (
                <td
                  key={block.firstWeek}
                  colSpan={WEEKS_PER_SHARE}
                  className={cn('p-0', monthEndWeeks.has(block.lastWeek) && 'border-r')}
                >
                  <button
                    type="button"
                    disabled={disabled}
                    aria-pressed={showWishes ? block.myWish : undefined}
                    aria-label={blockAriaLabel(block, { showWishes, actingShare })}
                    onClick={() => onBlockClick(block)}
                    className={cn(
                      'flex min-h-16 w-full flex-col items-center justify-center gap-1 px-1 py-2',
                      'transition-[background-color,box-shadow,filter] duration-150 ease-out motion-reduce:transition-none',
                      block.holder
                        ? cn(shareBackgroundClass[block.holder], 'font-medium text-foreground')
                        : 'text-muted-foreground',
                      block.kind === 'extra' && !block.holder && 'border border-dashed',
                      block.isMine && OWNED_RING,
                      !block.isMine && block.myWish && 'ring-2 ring-brand ring-inset',
                      selectedWeek === block.firstWeek && 'ring-2 ring-brand ring-inset',
                      !disabled && 'cursor-pointer hover:brightness-[0.97]',
                    )}
                  >
                    <span
                      className={cn(
                        'font-semibold',
                        block.holder && !block.holderAssigned && 'opacity-50',
                      )}
                    >
                      {block.holder ?? '–'}
                    </span>
                    {showWishes && <WishChips wishes={block.wishes} actingShare={actingShare} />}
                  </button>
                </td>
              )
            })}
          </tr>
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 4: Write `BookingCards.tsx`** (mobile, <lg — mirrors the Disponeringslista `YearCard`/`MonthSection` grammar)

```tsx
import type { MonthBand } from '~/lib/services/season/logic'
import type { ShareCode } from '~/lib/shares/codes'
import { shareBackgroundClass } from '~/lib/shares/colors'
import { cn } from '~/lib/utils'
import { MONTH_LABELS, OWNED_RING } from '~/components/season/calendar'
import { blockAriaLabel, type StripBlock } from './stripModel'
import { WishChips } from './WishChips'

type BookingCardsProps = {
  year: number
  monthBands: Array<MonthBand>
  blocks: Array<StripBlock>
  actingShare: ShareCode | null
  showWishes: boolean
  interactive: boolean
  onBlockClick: (block: StripBlock) => void
  selectedWeek: number | null
}

export function BookingCards({
  year,
  monthBands,
  blocks,
  actingShare,
  showWishes,
  interactive,
  onBlockClick,
  selectedWeek,
}: BookingCardsProps) {
  return (
    <article className="overflow-hidden rounded-lg border bg-surface-raised lg:hidden">
      <header className="flex items-center gap-2 border-b bg-muted px-4 py-2">
        <span className="font-semibold tabular-nums">{year}</span>
      </header>
      <div className="flex flex-col">
        {monthBands.map((band) => {
          const bandBlocks = blocks.filter(
            (b) => b.firstWeek >= band.firstWeek && b.firstWeek <= band.lastWeek,
          )
          // Blocks belong to the month of their first week; a tail-only band
          // renders nothing (Disponeringslista convention).
          if (bandBlocks.length === 0) return null
          return (
            <section key={band.firstWeek} className="border-b last:border-b-0">
              <h3 className="bg-muted/50 px-4 py-1 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
                {MONTH_LABELS[band.month]?.()}
              </h3>
              <div className="flex flex-col">
                {bandBlocks.map((block, i) => {
                  const ownTarget =
                    actingShare !== null && block.target.targetShare === actingShare
                  const disabled = !interactive || ownTarget
                  return (
                    <button
                      key={block.firstWeek}
                      type="button"
                      disabled={disabled}
                      aria-pressed={showWishes ? block.myWish : undefined}
                      aria-label={blockAriaLabel(block, { showWishes, actingShare })}
                      onClick={() => onBlockClick(block)}
                      className={cn(
                        'flex items-center justify-between gap-2 px-4 py-2 text-left',
                        'transition-[background-color,box-shadow] duration-150 ease-out motion-reduce:transition-none',
                        i > 0 && 'border-t',
                        block.holder && shareBackgroundClass[block.holder],
                        block.isMine && OWNED_RING,
                        !block.isMine && block.myWish && 'ring-2 ring-brand ring-inset',
                        selectedWeek === block.firstWeek && 'ring-2 ring-brand ring-inset',
                      )}
                    >
                      <span className="text-muted-foreground tabular-nums">
                        {block.firstWeek}–{block.lastWeek}
                      </span>
                      {showWishes && <WishChips wishes={block.wishes} actingShare={actingShare} />}
                      <span
                        className={cn(
                          'font-semibold',
                          block.holder && !block.holderAssigned && 'opacity-50',
                        )}
                      >
                        {block.holder ?? '–'}
                      </span>
                    </button>
                  )
                })}
              </div>
            </section>
          )
        })}
      </div>
    </article>
  )
}
```

- [ ] **Step 5: Lint pass**

Run: `pnpm check`
Expected: clean (Biome may reorder Tailwind classes — accept its rewrites).

- [ ] **Step 6: Commit**

```bash
git add src/components/booking/
git commit --no-gpg-sign -m "feat(booking): strip view-model and presentational components"
```

---

### Task 4: `BookingSection` + browser tests (test-first)

**Files:**
- Create: `src/components/booking/BookingSection.browser.test.tsx`
- Create: `src/components/booking/BookingSection.tsx`

**Interfaces:**
- Consumes: Task 3's components/model; `orpc` client + `optimisticReplace` (`~/lib/orpc/optimistic`) + `bookingErrorMessage`; `formatDate` from `~/lib/i18n/format`; `ToggleGroup`/`ToggleGroupItem` from `~/components/ui/toggle-group`; `toast` from `sonner`; `isDefinedError` (same import as `RenameDocumentDialog.tsx`).
- Produces: `BookingSection({ data, isAdmin, ownedShareCodes })` — mounted by Task 5's route; plan 06 extends this file (marked mount points).

**Fixture background:** 2027 under the seeded era starts at share A (J rotated −3×3 = index 0), weeks 21–40, so rotation letters are exactly A→J and extras are 19–20 / 41–42. The browser harness loads no Tailwind — both layouts are in the DOM; scope desktop assertions to `td[colspan="2"] button`.

- [ ] **Step 1: Write the failing browser tests**

Create `src/components/booking/BookingSection.browser.test.tsx` (import `renderWithProviders` the same way existing `*.browser.test.tsx` files import from `test/browser/render.tsx`):

```tsx
import { expect, test } from 'vitest'
import { page } from 'vitest/browser'
import { extraBlocksForSeason, type Slot } from '~/lib/services/booking/logic'
import { monthBandsForRange, shareBlocksForSeason } from '~/lib/services/season/logic'
import type { ShareCode } from '~/lib/shares/codes'
import { m } from '~/paraglide/messages'
import { renderWithProviders } from '~test/browser/render'
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
    <BookingSection data={makeData()} isAdmin={false} ownedShareCodes={new Set<ShareCode>(['A'])} />,
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
    <BookingSection data={makeData()} isAdmin={false} ownedShareCodes={new Set<ShareCode>(['A'])} />,
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run --project browser src/components/booking/BookingSection.browser.test.tsx`
Expected: FAIL — `./BookingSection` does not exist.

- [ ] **Step 3: Implement `BookingSection.tsx`**

```tsx
import { isDefinedError } from '@orpc/client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { LockIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'
import { formatDate } from '~/lib/i18n/format'
import { orpc } from '~/lib/orpc/client'
import { bookingErrorMessage } from '~/lib/orpc/bookingErrorMessage'
import { optimisticReplace } from '~/lib/orpc/optimistic'
import type { ShareCode } from '~/lib/shares/codes'
import { m } from '~/paraglide/messages'
import { BookingCards } from './BookingCards'
import { BookingStrip } from './BookingStrip'
import { type BookingData, buildStripBlocks, type StripBlock } from './stripModel'

type BookingSectionProps = {
  data: BookingData
  isAdmin: boolean
  ownedShareCodes: ReadonlySet<ShareCode>
}

// The booking round above the Disponeringslista (ADR-0020): "convention
// below, reality above". Owners toggle wishes while open; the locked view
// shows everyone's final weeks. Admin arranging/locking is layered on in
// plan 06.
export function BookingSection({ data, isAdmin, ownedShareCodes }: BookingSectionProps) {
  const queryClient = useQueryClient()
  const myShares = useMemo(() => [...ownedShareCodes].sort(), [ownedShareCodes])
  // Derived during render, not seeded state: if the selected share disappears
  // (unassigned mid-round + realtime refresh), fall back to the first owned
  // share instead of acting as a share the user no longer holds.
  const [selectedShare, setSelectedShare] = useState<ShareCode | null>(null)
  const actingShare =
    selectedShare !== null && myShares.includes(selectedShare)
      ? selectedShare
      : (myShares[0] ?? null)
  const locked = data.lockedAt !== null

  const activeKey = orpc.booking.getActive.queryKey()

  // Optimistic instant toggles (standing mutation rules): paint in onMutate,
  // reconcile via invalidate in onSettled, callbacks in mutationOptions so
  // they survive any unmount; no success toast — the paint is the
  // confirmation.
  const addWishMutation = useMutation(
    orpc.booking.addWish.mutationOptions({
      onMutate: (vars) =>
        optimisticReplace(queryClient, activeKey, (old) => ({
          ...old,
          wishes: [
            ...old.wishes,
            {
              id: `optimistic-${vars.shareCode}-${vars.targetKind}-${vars.targetShare ?? ''}`,
              ...vars,
            },
          ],
        })),
      onError: (err) =>
        toast.error(
          isDefinedError(err) ? bookingErrorMessage(err.code) : m.booking_error_generic(),
        ),
      onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.booking.key() }),
    }),
  )

  const removeWishMutation = useMutation(
    orpc.booking.removeWish.mutationOptions({
      onMutate: (vars) =>
        optimisticReplace(queryClient, activeKey, (old) => ({
          ...old,
          wishes: old.wishes.filter(
            (w) =>
              !(
                w.shareCode === vars.shareCode &&
                w.targetKind === vars.targetKind &&
                w.targetShare === vars.targetShare
              ),
          ),
        })),
      onError: (err) =>
        toast.error(
          isDefinedError(err) ? bookingErrorMessage(err.code) : m.booking_error_generic(),
        ),
      onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.booking.key() }),
    }),
  )

  const stripBlocks = useMemo(
    () => buildStripBlocks(data, actingShare, ownedShareCodes, data.lockedSchedule),
    [data, actingShare, ownedShareCodes],
  )

  const interactive = !locked && actingShare !== null

  const onBlockClick = (block: StripBlock) => {
    if (!interactive || !actingShare || block.target.targetShare === actingShare) return
    const vars = { shareCode: actingShare, ...block.target }
    if (block.myWish) removeWishMutation.mutate(vars)
    else addWishMutation.mutate(vars)
  }

  const myLockedRanges = useMemo(
    () =>
      (data.lockedSchedule ?? [])
        .filter((s) => s.holder !== null && ownedShareCodes.has(s.holder))
        .map((s) => `${s.firstWeek}–${s.lastWeek}`),
    [data.lockedSchedule, ownedShareCodes],
  )

  const stripProps = {
    year: data.year,
    monthBands: data.monthBands,
    blocks: stripBlocks,
    actingShare,
    showWishes: !locked,
    interactive,
    onBlockClick,
    selectedWeek: null,
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="font-heading font-semibold text-lg tracking-tight">
          {m.booking_title({ year: data.year })}
        </h2>
        {data.lockedAt ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 font-medium text-muted-foreground text-xs">
            <LockIcon className="size-3" aria-hidden />
            {m.booking_status_locked({ date: formatDate(data.lockedAt) })}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-brand/10 px-2.5 py-1 font-medium text-brand text-xs">
            <span className="size-1.5 rounded-full bg-brand" aria-hidden />
            {m.booking_status_open()}
          </span>
        )}
        {/* plan 06: admin controls (Ordna / Lås säsong; Lås upp in the locked chip) mount here */}
      </div>
      {!locked && myShares.length > 1 && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{m.booking_wish_as()}</span>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={actingShare ?? undefined}
            onValueChange={(value) => value && setSelectedShare(value as ShareCode)}
          >
            {myShares.map((code) => (
              <ToggleGroupItem key={code} value={code} className="px-3 tabular-nums">
                {code}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      )}
      <BookingStrip {...stripProps} />
      <BookingCards {...stripProps} />
      {!locked && myShares.length > 0 && (
        <p className="text-muted-foreground text-sm">{m.booking_helper_owner()}</p>
      )}
      {locked && myLockedRanges.length > 0 && (
        <p className="text-sm">
          {m.booking_locked_my_weeks({ year: data.year, weeks: myLockedRanges.join(' + ') })}
        </p>
      )}
    </section>
  )
}
```

(JSX spreads don't excess-property-check, so passing `stripProps` — which carries `year` for `BookingCards` — into `BookingStrip` compiles even though `BookingStrip` declares no `year` prop.)

- [ ] **Step 4: Run the browser tests to verify they pass**

Run: `pnpm vitest run --project browser src/components/booking/BookingSection.browser.test.tsx`
Expected: PASS — all 6.

- [ ] **Step 5: Commit**

```bash
git add src/components/booking/BookingSection.tsx src/components/booking/BookingSection.browser.test.tsx
git commit --no-gpg-sign -m "feat(booking): owner booking section with optimistic wish toggles"
```

---

### Task 5: route wiring

**Files:**
- Modify: `src/routes/_authenticated/index.tsx`

**Interfaces:**
- Consumes: `orpc.booking.getActive` (plan 04), `BookingSection` (Task 4), route context `user` (provided by `_authenticated.tsx`'s `beforeLoad` — same accessor it uses itself: `Route.useRouteContext()`).

- [ ] **Step 1: Prefetch + mount**

In `src/routes/_authenticated/index.tsx`:

Add to the loader (after the existing two `ensureQueryData` awaits):

```ts
    await queryClient.ensureQueryData(orpc.booking.getActive.queryOptions())
```

Add the imports:

```ts
import { BookingSection } from '~/components/booking/BookingSection'
```

In `Calendar`, read the context user and the booking query (alongside the existing `useSuspenseQuery` calls):

```tsx
  const { user } = Route.useRouteContext()
  const { data: booking } = useSuspenseQuery(orpc.booking.getActive.queryOptions())
```

Mount between the `<h1>` and `<DisponeringslistaTable>` ("reality above, convention below"):

```tsx
      <BookingSection
        data={booking}
        isAdmin={user.role === 'admin'}
        ownedShareCodes={ownedShareCodes}
      />
```

- [ ] **Step 2: Full check**

Run: `pnpm check && pnpm build && pnpm test`
Expected: all green (node + browser projects).

- [ ] **Step 3: Quick live sanity (optional but cheap)**

With `pnpm dev` running and a signed-in session: `/` shows `Bokning 2027` (or the current active year) with the strip above the Disponeringslista; clicking another share's block paints a chip instantly; a second tab reflects it via `booking.changed` (realtime).

- [ ] **Step 4: Commit**

```bash
git add src/routes/_authenticated/index.tsx
git commit --no-gpg-sign -m "feat(booking): mount the booking section on the calendar page"
```
