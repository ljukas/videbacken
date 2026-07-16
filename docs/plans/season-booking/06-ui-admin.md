# Plan 06 — Admin UI: arrange mode, suggestion panel, lock/unlock

> Part of [season-booking](./README.md). Requires plans 01–05 committed. Steps use checkbox syntax for tracking.

**Goal:** Admins can enter **arrange mode** on the open round (draft fetched lazily via `getDraft`), apply the solver suggestion, swap rotation slots select-then-act, assign extras/unassigned blocks via a popover, reset the draft, and lock/unlock behind `AlertDialog` confirms. The strip shows the draft's holders while arranging (wish chips stay visible); owners keep seeing nominal until lock.

**Interaction rules (binding, from ADR-0020 §UI + service guards):**
- Select-then-act applies to **assigned rotation slots** only: first click selects (brand ring), second click swaps (`swapSlots`), clicking the selected block or pressing Esc deselects.
- **Extras and rotation slots held by an unassigned share** open a holder popover instead: interested shares first (from the wish chips), then the remaining shares, plus `Töm` **on extras only** (the service rejects clearing a rotation slot).
- `applySuggestion`/`resetDraft`: plain pending-disabled mutations. `setSlotHolder`/`swapSlots`: optimistic on the `getDraft` cache. `lock`/`unlock`: pessimistic behind `AlertDialog` (dialog closes in `onSuccess`).
- No-input mutations (`applySuggestion`, `resetDraft`, `lock`, `unlock`): call `mutate(undefined)`; if the generated orpc types demand something else, match how the repo invokes its no-input mutations (e.g. `completeOnboarding` in the onboarding wizard).

---

### Task 1: admin i18n keys

**Files:**
- Modify: `messages/sv.json`, `messages/en.json`

- [ ] **Step 1: Add the keys** (into the `booking_*` block, alphabetical)

`messages/sv.json`:

```json
  "booking_arrange": "Ordna",
  "booking_arrange_block_aria": "Välj veckor {from}–{to}",
  "booking_arrange_done": "Klar",
  "booking_arrange_hint": "Klicka på ett block för att flytta eller byta",
  "booking_arrange_selected_hint": "Byt {block} — välj ett annat block · Esc avbryter",
  "booking_clear_holder": "Töm",
  "booking_draft_chip": "Utkast — endast synligt för admins",
  "booking_lock": "Lås säsong",
  "booking_lock_confirm_body": "Alla ser sina slutgiltiga veckor direkt. Du kan låsa upp igen senare.",
  "booking_lock_confirm_title": "Lås säsongen {year}?",
  "booking_reset": "Återställ",
  "booking_suggestion_apply": "Använd förslaget",
  "booking_suggestion_none": "Inga byten att föreslå ännu",
  "booking_suggestion_open_extras": "Att fördela manuellt: {list}",
  "booking_suggestion_summary": "Förslaget uppfyller {satisfied} av {total} bytesönskemål",
  "booking_unlock": "Lås upp…",
  "booking_unlock_confirm_body": "Schemat döljs och önskerundan öppnas igen.",
  "booking_unlock_confirm_title": "Lås upp säsongen {year}?",
```

`messages/en.json`:

```json
  "booking_arrange": "Arrange",
  "booking_arrange_block_aria": "Select weeks {from}–{to}",
  "booking_arrange_done": "Done",
  "booking_arrange_hint": "Click a block to move or swap",
  "booking_arrange_selected_hint": "Swap {block} — pick another block · Esc cancels",
  "booking_clear_holder": "Clear",
  "booking_draft_chip": "Draft — only visible to admins",
  "booking_lock": "Lock season",
  "booking_lock_confirm_body": "Everyone sees their final weeks immediately. You can unlock again later.",
  "booking_lock_confirm_title": "Lock season {year}?",
  "booking_reset": "Reset",
  "booking_suggestion_apply": "Apply suggestion",
  "booking_suggestion_none": "No trades to suggest yet",
  "booking_suggestion_open_extras": "To assign manually: {list}",
  "booking_suggestion_summary": "The suggestion satisfies {satisfied} of {total} trade wishes",
  "booking_unlock": "Unlock…",
  "booking_unlock_confirm_body": "The schedule is hidden and the wish round reopens.",
  "booking_unlock_confirm_title": "Unlock season {year}?",
```

Run: `pnpm i18n:compile`
Expected: succeeds.

- [ ] **Step 2: Commit**

```bash
git add messages/sv.json messages/en.json
git commit --no-gpg-sign -m "feat(i18n): admin booking messages"
```

---

### Task 2: arrange support in the strip components

**Files:**
- Modify: `src/components/booking/stripModel.ts`
- Modify: `src/components/booking/BookingStrip.tsx`
- Modify: `src/components/booking/BookingCards.tsx`

**Interfaces:**
- Produces: an optional `arrange: ArrangeControls | null` prop on both layouts (plan 05 call sites pass it via the shared props object) and an `arranging` flag on `blockAriaLabel`:

  ```ts
  export type ArrangeControls = {
    popoverWeek: number | null
    onPopoverWeekChange: (week: number | null) => void
    renderHolderPicker: (block: StripBlock) => ReactNode
  }
  ```

- [ ] **Step 1: Extend `stripModel.ts`**

Add the `ArrangeControls` type above (plus `import type { ReactNode } from 'react'`), and replace `blockAriaLabel` with:

```ts
// The block button's accessible name. Arrange mode announces selection;
// while wishable it announces the action; otherwise (locked, or the acting
// share's own block) it announces ownership like the Disponeringslista.
export function blockAriaLabel(
  block: StripBlock,
  input: { showWishes: boolean; actingShare: ShareCode | null; arranging: boolean },
): string | undefined {
  if (input.arranging) {
    return m.booking_arrange_block_aria({ from: block.firstWeek, to: block.lastWeek })
  }
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

- [ ] **Step 2: Extend `BookingStrip.tsx`**

Add to the props type: `arrange: ArrangeControls | null` (import `ArrangeControls` from `./stripModel`; import `Popover, PopoverContent, PopoverTrigger` from `~/components/ui/popover`). Replace the block-cell body with:

```tsx
          <tr>
            {blocks.map((block) => {
              const ownTarget = actingShare !== null && block.target.targetShare === actingShare
              const disabled = arrange ? false : !interactive || ownTarget
              // Extras and unassigned-held rotation slots are popover-assigned
              // in arrange mode; assigned rotation slots use select-then-act.
              const popoverSlot = arrange !== null && (block.kind === 'extra' || !block.holderAssigned)
              const cellButton = (
                <button
                  type="button"
                  disabled={disabled}
                  aria-pressed={showWishes && !arrange ? block.myWish : undefined}
                  aria-label={blockAriaLabel(block, {
                    showWishes,
                    actingShare,
                    arranging: arrange !== null,
                  })}
                  onClick={() => onBlockClick(block)}
                  className={cn(
                    'flex min-h-16 w-full flex-col items-center justify-center gap-1 px-1 py-2',
                    'transition-[background-color,box-shadow,filter] duration-150 ease-out motion-reduce:transition-none',
                    block.holder
                      ? cn(shareBackgroundClass[block.holder], 'font-medium text-foreground')
                      : 'text-muted-foreground',
                    block.kind === 'extra' && !block.holder && 'border border-dashed',
                    block.isMine && OWNED_RING,
                    !block.isMine && block.myWish && !arrange && 'ring-2 ring-brand ring-inset',
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
              )
              return (
                <td
                  key={block.firstWeek}
                  colSpan={WEEKS_PER_SHARE}
                  className={cn('p-0', monthEndWeeks.has(block.lastWeek) && 'border-r')}
                >
                  {popoverSlot && arrange ? (
                    <Popover
                      open={arrange.popoverWeek === block.firstWeek}
                      onOpenChange={(open) =>
                        arrange.onPopoverWeekChange(open ? block.firstWeek : null)
                      }
                    >
                      <PopoverTrigger asChild>{cellButton}</PopoverTrigger>
                      <PopoverContent align="center" className="w-52 p-1.5">
                        {arrange.renderHolderPicker(block)}
                      </PopoverContent>
                    </Popover>
                  ) : (
                    cellButton
                  )}
                </td>
              )
            })}
          </tr>
```

- [ ] **Step 3: Extend `BookingCards.tsx` the same way**

Add the `arrange: ArrangeControls | null` prop and, inside the `bandBlocks.map`, compute the same three locals as the strip:

```tsx
                  const ownTarget =
                    actingShare !== null && block.target.targetShare === actingShare
                  const disabled = arrange ? false : !interactive || ownTarget
                  const popoverSlot =
                    arrange !== null && (block.kind === 'extra' || !block.holderAssigned)
```

Apply the same three attribute changes to the row `<button>` as the strip's cell button: `aria-pressed={showWishes && !arrange ? block.myWish : undefined}`, `aria-label={blockAriaLabel(block, { showWishes, actingShare, arranging: arrange !== null })}`, and the wish-ring condition gains `&& !arrange`. The row button markup is otherwise unchanged from plan 05. Then wrap it:

```tsx
                  return popoverSlot && arrange ? (
                    <Popover
                      key={block.firstWeek}
                      open={arrange.popoverWeek === block.firstWeek}
                      onOpenChange={(open) =>
                        arrange.onPopoverWeekChange(open ? block.firstWeek : null)
                      }
                    >
                      <PopoverTrigger asChild>{rowButton}</PopoverTrigger>
                      <PopoverContent align="start" className="w-52 p-1.5">
                        {arrange.renderHolderPicker(block)}
                      </PopoverContent>
                    </Popover>
                  ) : (
                    rowButton
                  )
```

(where `rowButton` is the plan-05 row `<button>` extracted into a local `const rowButton = (…)` — move the `key` onto the outermost rendered element as shown).

- [ ] **Step 4: Verify plan-05 tests still pass**

Plan 05's `stripProps` object must now include `arrange: null` (add it in `BookingSection.tsx`) and the `blockAriaLabel` call sites compile with the new flag. Run:

`pnpm vitest run --project browser src/components/booking/BookingSection.browser.test.tsx`
Expected: PASS (owner behavior unchanged when `arrange` is null).

- [ ] **Step 5: Commit**

```bash
git add src/components/booking/
git commit --no-gpg-sign -m "feat(booking): arrange-mode plumbing in the strip layouts"
```

---

### Task 3: `SuggestionPanel` + `ArrangeBar`

**Files:**
- Create: `src/components/booking/SuggestionPanel.tsx`
- Create: `src/components/booking/ArrangeBar.tsx`

**Interfaces:**
- Consumes: `Suggestion` type from `~/lib/services/booking/logic` (type-only import), `Button` from `~/components/ui/button`.
- Produces: `SuggestionPanel({ suggestion, onApply, applying })`, `ArrangeBar({ selectedLabel, draftExists, onReset, resetting, onDone })` — Task 4 mounts both.

- [ ] **Step 1: Write `SuggestionPanel.tsx`**

```tsx
import type { Suggestion } from '~/lib/services/booking/logic'
import { Button } from '~/components/ui/button'
import { m } from '~/paraglide/messages'

type SuggestionPanelProps = {
  suggestion: Suggestion
  onApply: () => void
  applying: boolean
}

// Quiet banner (ADR-0020 §UI): satisfaction summary + move pills
// (cycles, auto-granted extras) + apply. Contested extras are listed for
// manual assignment — deliberately no fairness algorithm.
export function SuggestionPanel({ suggestion, onApply, applying }: SuggestionPanelProps) {
  const pills = [
    ...suggestion.cycles.map((cycle) =>
      cycle.length === 2
        ? `${cycle[0]} ↔ ${cycle[1]}`
        : [...cycle, cycle[0]].join(' → '),
    ),
    ...suggestion.autoExtras.map((x) => `${x.firstWeek}–${x.lastWeek} → ${x.holder}`),
  ]
  const hasMoves = pills.length > 0
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-brand/5 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">
          {hasMoves
            ? m.booking_suggestion_summary({
                satisfied: suggestion.satisfiedShares.length,
                total: suggestion.tradeWishShares.length,
              })
            : m.booking_suggestion_none()}
        </p>
        {hasMoves ? (
          <Button size="sm" className="ml-auto" onClick={onApply} disabled={applying}>
            {m.booking_suggestion_apply()}
          </Button>
        ) : null}
      </div>
      {hasMoves ? (
        <div className="flex flex-wrap gap-1.5">
          {pills.map((pill) => (
            <span
              key={pill}
              className="rounded-full bg-brand/10 px-2 py-0.5 text-brand text-xs tabular-nums"
            >
              {pill}
            </span>
          ))}
        </div>
      ) : null}
      {suggestion.openExtras.length > 0 ? (
        <p className="text-muted-foreground text-xs">
          {m.booking_suggestion_open_extras({
            list: suggestion.openExtras
              .map((x) => `${x.firstWeek}–${x.lastWeek} (${x.interested.join(', ')})`)
              .join(' · '),
          })}
        </p>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 2: Write `ArrangeBar.tsx`**

```tsx
import { Button } from '~/components/ui/button'
import { m } from '~/paraglide/messages'

type ArrangeBarProps = {
  // "A · 21–22" while a block is selected, else null.
  selectedLabel: string | null
  draftExists: boolean
  onReset: () => void
  resetting: boolean
  onDone: () => void
}

// Slim select-then-act bar (ADR-0020 §UI): hint text, the admin-only draft
// chip, reset (escape hatch to nominal) and done (exit arrange mode).
export function ArrangeBar({
  selectedLabel,
  draftExists,
  onReset,
  resetting,
  onDone,
}: ArrangeBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2 text-sm">
      <p className="text-muted-foreground" aria-live="polite">
        {selectedLabel
          ? m.booking_arrange_selected_hint({ block: selectedLabel })
          : m.booking_arrange_hint()}
      </p>
      <div className="ml-auto flex items-center gap-2">
        {draftExists ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">
            {m.booking_draft_chip()}
          </span>
        ) : null}
        <Button variant="ghost" size="sm" onClick={onReset} disabled={resetting}>
          {m.booking_reset()}
        </Button>
        <Button variant="outline" size="sm" onClick={onDone}>
          {m.booking_arrange_done()}
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add src/components/booking/SuggestionPanel.tsx src/components/booking/ArrangeBar.tsx
git commit --no-gpg-sign -m "feat(booking): suggestion panel and arrange bar"
```

---

### Task 4: admin wiring in `BookingSection` + browser tests

**Files:**
- Modify: `src/components/booking/BookingSection.tsx`
- Modify: `src/components/booking/BookingSection.browser.test.tsx`

**Interfaces:**
- Consumes: `orpc.booking.getDraft` (plan 04); Task 2's `ArrangeControls`; Task 3's components; `AlertDialog*` from `~/components/ui/alert-dialog` (compose it like `DeleteUserDialog.tsx`, including its cancel-label message key); `DropdownMenu*` from `~/components/ui/dropdown-menu`; `Button`; `SHARE_CODES`.

- [ ] **Step 1: Write the failing browser tests**

Append to `BookingSection.browser.test.tsx` (add imports: `buildSuggestion` from `~/lib/services/booking/logic`, `orpc` from `~/lib/orpc/client`, `makeTestQueryClient` from the render helper module):

```tsx
test('admins see arrange and lock controls on an open round; owners do not', async () => {
  const admin = await renderWithProviders(
    <BookingSection data={makeData()} isAdmin ownedShareCodes={NO_SHARES} />,
  )
  await expect.element(admin.screen.getByRole('button', { name: m.booking_arrange() })).toBeVisible()
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
    .element(screen.getByText(m.booking_suggestion_summary({ satisfied: 2, total: 2 })))
    .toBeVisible()
  await expect.element(screen.getByText('A ↔ C')).toBeVisible()
  await expect.element(screen.getByText(m.booking_draft_chip())).toBeVisible()
  // The strip now shows the draft's holders: C on A's nominal block (21–22).
  const cells = [...screen.container.querySelectorAll('td[colspan="2"] button')]
  expect(cells[1]?.textContent).toContain('C')
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
  await screen.getByRole('button', { name: new RegExp(m.booking_status_locked({ date: '' }).trim()) }).click()
  await expect.element(screen.getByRole('menuitem', { name: m.booking_unlock() })).toBeVisible()
})
```

(If the regex-name locator for the chip is brittle, give the chip trigger an explicit `aria-label={m.booking_status_locked({ date: formatDate(data.lockedAt) })}` and locate by that exact string — adjust test and component together.)

- [ ] **Step 2: Run to verify the new tests fail**

Run: `pnpm vitest run --project browser src/components/booking/BookingSection.browser.test.tsx`
Expected: the three new tests FAIL (no admin controls exist); plan-05 tests still PASS.

- [ ] **Step 3: Wire the admin state machine into `BookingSection.tsx`**

Additions (imports: `useEffect`, `useQuery`, `SHARE_CODES`, `ChevronDownIcon` from lucide, the ui components above, `SuggestionPanel`, `ArrangeBar`, `ArrangeControls`):

State + draft query (after the plan-05 state):

```tsx
  const [arranging, setArranging] = useState(false)
  const [selectedWeek, setSelectedWeek] = useState<number | null>(null)
  const [popoverWeek, setPopoverWeek] = useState<number | null>(null)
  const [confirm, setConfirm] = useState<'lock' | 'unlock' | null>(null)

  // Draft fetched lazily on entering arrange mode — keeps the owner payload
  // lean and the admin-only draft out of the shared getActive cache.
  const draftQuery = useQuery(
    orpc.booking.getDraft.queryOptions({ enabled: isAdmin && arranging && !locked }),
  )
  const draft = isAdmin && arranging && !locked ? (draftQuery.data ?? null) : null
  const draftKey = orpc.booking.getDraft.queryKey()

  // Esc deselects (select-then-act escape hatch).
  useEffect(() => {
    if (selectedWeek === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedWeek(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedWeek])
```

Shared mutation plumbing + admin mutations:

```tsx
  const invalidateBooking = () =>
    queryClient.invalidateQueries({ queryKey: orpc.booking.key() })
  const showMutationError = (err: unknown) =>
    toast.error(isDefinedError(err) ? bookingErrorMessage(err.code) : m.booking_error_generic())

  const swapMutation = useMutation(
    orpc.booking.swapSlots.mutationOptions({
      onMutate: (vars) =>
        optimisticReplace(queryClient, draftKey, (old) => {
          const holderAt = (week: number) =>
            old.slots.find((s) => s.firstWeek === week)?.holder ?? null
          return {
            ...old,
            draftExists: true,
            slots: old.slots.map((s) =>
              s.firstWeek === vars.firstWeekA
                ? { ...s, holder: holderAt(vars.firstWeekB) }
                : s.firstWeek === vars.firstWeekB
                  ? { ...s, holder: holderAt(vars.firstWeekA) }
                  : s,
            ),
          }
        }),
      onError: showMutationError,
      onSettled: invalidateBooking,
    }),
  )

  const setHolderMutation = useMutation(
    orpc.booking.setSlotHolder.mutationOptions({
      onMutate: (vars) =>
        optimisticReplace(queryClient, draftKey, (old) => ({
          ...old,
          draftExists: true,
          slots: old.slots.map((s) =>
            s.firstWeek === vars.firstWeek ? { ...s, holder: vars.holder } : s,
          ),
        })),
      onError: showMutationError,
      onSettled: invalidateBooking,
    }),
  )

  const applySuggestionMutation = useMutation(
    orpc.booking.applySuggestion.mutationOptions({
      onError: showMutationError,
      onSettled: invalidateBooking,
    }),
  )
  const resetDraftMutation = useMutation(
    orpc.booking.resetDraft.mutationOptions({
      onError: showMutationError,
      onSettled: invalidateBooking,
    }),
  )
  // Pessimistic pair: the AlertDialog stays open until success.
  const lockMutation = useMutation(
    orpc.booking.lock.mutationOptions({
      onSuccess: () => {
        setConfirm(null)
        setArranging(false)
        setSelectedWeek(null)
        setPopoverWeek(null)
      },
      onError: showMutationError,
      onSettled: invalidateBooking,
    }),
  )
  const unlockMutation = useMutation(
    orpc.booking.unlock.mutationOptions({
      onSuccess: () => setConfirm(null),
      onError: showMutationError,
      onSettled: invalidateBooking,
    }),
  )
```

Strip derivation + click routing (replace the plan-05 versions):

```tsx
  const stripBlocks = useMemo(
    () =>
      buildStripBlocks(
        data,
        actingShare,
        ownedShareCodes,
        data.lockedSchedule ?? draft?.slots ?? null,
      ),
    [data, actingShare, ownedShareCodes, draft],
  )

  const onBlockClick = (block: StripBlock) => {
    if (draft) {
      // Arrange mode. Popover slots (extras / unassigned) are handled by the
      // Popover itself — only assigned rotation slots select-then-act here.
      if (block.kind === 'extra' || !block.holderAssigned) return
      if (selectedWeek === null) {
        setSelectedWeek(block.firstWeek)
        return
      }
      if (selectedWeek === block.firstWeek) {
        setSelectedWeek(null)
        return
      }
      swapMutation.mutate({ firstWeekA: selectedWeek, firstWeekB: block.firstWeek })
      setSelectedWeek(null)
      return
    }
    if (!interactive || !actingShare || block.target.targetShare === actingShare) return
    const vars = { shareCode: actingShare, ...block.target }
    if (block.myWish) removeWishMutation.mutate(vars)
    else addWishMutation.mutate(vars)
  }
```

Holder picker + arrange controls + selection label:

```tsx
  const renderHolderPicker = (block: StripBlock) => {
    const others = SHARE_CODES.filter((code) => !block.wishes.includes(code))
    const pick = (holder: ShareCode | null) => {
      setHolderMutation.mutate({ firstWeek: block.firstWeek, holder })
      setPopoverWeek(null)
    }
    return (
      <div className="flex flex-col gap-1">
        {block.wishes.length > 0 && (
          <div className="flex flex-wrap gap-1 border-b pb-1.5">
            {block.wishes.map((code) => (
              <Button
                key={code}
                variant="secondary"
                size="sm"
                className="tabular-nums"
                onClick={() => pick(code)}
              >
                {code}
              </Button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-1">
          {others.map((code) => (
            <Button
              key={code}
              variant="ghost"
              size="sm"
              className="tabular-nums"
              onClick={() => pick(code)}
            >
              {code}
            </Button>
          ))}
        </div>
        {block.kind === 'extra' && (
          <Button variant="ghost" size="sm" onClick={() => pick(null)}>
            {m.booking_clear_holder()}
          </Button>
        )}
      </div>
    )
  }

  const arrangeControls: ArrangeControls | null = draft
    ? { popoverWeek, onPopoverWeekChange: setPopoverWeek, renderHolderPicker }
    : null

  const selectedBlock =
    selectedWeek !== null ? (stripBlocks.find((b) => b.firstWeek === selectedWeek) ?? null) : null
  const selectedLabel = selectedBlock
    ? `${selectedBlock.holder ?? '–'} · ${selectedBlock.firstWeek}–${selectedBlock.lastWeek}`
    : null
```

In `stripProps`, replace `selectedWeek: null` with the `selectedWeek` state variable, add `arrange: arrangeControls`, and redefine `interactive` as:

```tsx
  const interactive = !locked && (draft !== null || actingShare !== null)
```

JSX changes:

1. Replace the plan-05 `{/* plan 06: admin controls ... */}` comment with:

```tsx
        {isAdmin && !locked && (
          <div className="ml-auto flex items-center gap-2">
            {!arranging && (
              <Button variant="outline" size="sm" onClick={() => setArranging(true)}>
                {m.booking_arrange()}
              </Button>
            )}
            <Button size="sm" onClick={() => setConfirm('lock')}>
              {m.booking_lock()}
            </Button>
          </div>
        )}
```

2. Replace the plain locked chip with an admin-aware version (non-admins keep the plan-05 `<span>`):

```tsx
        {data.lockedAt ? (
          isAdmin ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={m.booking_status_locked({ date: formatDate(data.lockedAt) })}
                  className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 font-medium text-muted-foreground text-xs"
                >
                  <LockIcon className="size-3" aria-hidden />
                  {m.booking_status_locked({ date: formatDate(data.lockedAt) })}
                  <ChevronDownIcon className="size-3" aria-hidden />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onSelect={() => setConfirm('unlock')}>
                  {m.booking_unlock()}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 font-medium text-muted-foreground text-xs">
              <LockIcon className="size-3" aria-hidden />
              {m.booking_status_locked({ date: formatDate(data.lockedAt) })}
            </span>
          )
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-brand/10 px-2.5 py-1 font-medium text-brand text-xs">
            <span className="size-1.5 rounded-full bg-brand" aria-hidden />
            {m.booking_status_open()}
          </span>
        )}
```

3. Between the acting-share selector and `<BookingStrip>`:

```tsx
      {draft && (
        <>
          <SuggestionPanel
            suggestion={draft.suggestion}
            onApply={() => applySuggestionMutation.mutate(undefined)}
            applying={applySuggestionMutation.isPending}
          />
          <ArrangeBar
            selectedLabel={selectedLabel}
            draftExists={draft.draftExists}
            onReset={() => resetDraftMutation.mutate(undefined)}
            resetting={resetDraftMutation.isPending}
            onDone={() => {
              setArranging(false)
              setSelectedWeek(null)
              setPopoverWeek(null)
            }}
          />
        </>
      )}
```

4. After the closing strip/cards, the two confirm dialogs (compose exactly like `DeleteUserDialog.tsx`, pessimistic — `e.preventDefault()` on the action so the dialog only closes via `onSuccess`):

```tsx
      <AlertDialog open={confirm === 'lock'} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.booking_lock_confirm_title({ year: data.year })}</AlertDialogTitle>
            <AlertDialogDescription>{m.booking_lock_confirm_body()}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{/* same cancel key as DeleteUserDialog */}</AlertDialogCancel>
            <AlertDialogAction
              disabled={lockMutation.isPending}
              onClick={(e) => {
                e.preventDefault()
                lockMutation.mutate(undefined)
              }}
            >
              {m.booking_lock()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirm === 'unlock'} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.booking_unlock_confirm_title({ year: data.year })}</AlertDialogTitle>
            <AlertDialogDescription>{m.booking_unlock_confirm_body()}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{/* same cancel key as DeleteUserDialog */}</AlertDialogCancel>
            <AlertDialogAction
              disabled={unlockMutation.isPending}
              onClick={(e) => {
                e.preventDefault()
                unlockMutation.mutate(undefined)
              }}
            >
              {m.booking_unlock()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
```

(Fill the two `AlertDialogCancel` bodies with the repo's existing cancel message key — copy it from `DeleteUserDialog.tsx` when implementing.)

- [ ] **Step 4: Run all booking browser tests**

Run: `pnpm vitest run --project browser src/components/booking/BookingSection.browser.test.tsx`
Expected: PASS — plan-05 tests + the three new ones.

- [ ] **Step 5: Full check**

Run: `pnpm check && pnpm build && pnpm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/components/booking/
git commit --no-gpg-sign -m "feat(booking): admin arrange mode with suggestion, swaps and locking"
```
