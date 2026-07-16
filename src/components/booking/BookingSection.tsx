import { isDefinedError } from '@orpc/client'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDownIcon, LockIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog'
import { Button } from '~/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'
import { formatDate } from '~/lib/i18n/format'
import { bookingErrorMessage } from '~/lib/orpc/bookingErrorMessage'
import { orpc } from '~/lib/orpc/client'
import { optimisticReplace } from '~/lib/orpc/optimistic'
import { SHARE_CODES, type ShareCode } from '~/lib/shares/codes'
import { m } from '~/paraglide/messages'
import { ArrangeBar } from './ArrangeBar'
import { BookingCards } from './BookingCards'
import { BookingStrip } from './BookingStrip'
import { SuggestionPanel } from './SuggestionPanel'
import {
  type ArrangeControls,
  type BookingData,
  buildStripBlocks,
  type PopoverLayout,
  type StripBlock,
} from './stripModel'

type BookingSectionProps = {
  data: BookingData
  isAdmin: boolean
  ownedShareCodes: ReadonlySet<ShareCode>
}

// The booking round above the Disponeringslista (ADR-0020): "convention
// below, reality above". Owners toggle wishes while open; the locked view
// shows everyone's final weeks. Admins enter arrange mode to apply the
// suggestion, swap/assign blocks against a lazily-fetched draft, and lock.
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

  const [arranging, setArranging] = useState(false)
  const [selectedWeek, setSelectedWeek] = useState<number | null>(null)
  const [popover, setPopover] = useState<{ week: number; layout: PopoverLayout } | null>(null)
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

  const invalidateBooking = () => queryClient.invalidateQueries({ queryKey: orpc.booking.key() })
  // Generic so the mutation's typed-error union flows in at each call site
  // (matching the inline addWish/removeWish handlers): isDefinedError then
  // narrows `err.code` to BookingDomainErrorCode. `(err: unknown)` would
  // collapse the Extract to `never`.
  const showMutationError = <T,>(err: T) =>
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
        setPopover(null)
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

  const interactive = !locked && (draft !== null || actingShare !== null)

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
    // Arrange mode entered but the draft hasn't loaded yet: do nothing.
    // Without this, an admin who also owns a share would fall through to the
    // wish toggle below during the fetch window.
    if (arranging) return
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

  const renderHolderPicker = (block: StripBlock) => {
    const others = SHARE_CODES.filter((code) => !block.wishes.includes(code))
    const pick = (holder: ShareCode | null) => {
      setHolderMutation.mutate({ firstWeek: block.firstWeek, holder })
      setPopover(null)
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
    ? { popover, onPopoverChange: setPopover, renderHolderPicker }
    : null

  const selectedBlock =
    selectedWeek !== null ? (stripBlocks.find((b) => b.firstWeek === selectedWeek) ?? null) : null
  const selectedLabel = selectedBlock
    ? `${selectedBlock.holder ?? '–'} · ${selectedBlock.firstWeek}–${selectedBlock.lastWeek}`
    : null

  const stripProps = {
    year: data.year,
    monthBands: data.monthBands,
    blocks: stripBlocks,
    actingShare,
    showWishes: !locked,
    interactive,
    onBlockClick,
    selectedWeek,
    arrange: arrangeControls,
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="font-heading font-semibold text-lg tracking-tight">
          {m.booking_title({ year: data.year })}
        </h2>
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
              setPopover(null)
            }}
          />
        </>
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
      <AlertDialog open={confirm === 'lock'} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.booking_lock_confirm_title({ year: data.year })}</AlertDialogTitle>
            <AlertDialogDescription>{m.booking_lock_confirm_body()}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={lockMutation.isPending}>
              {m.common_cancel()}
            </AlertDialogCancel>
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
            <AlertDialogTitle>
              {m.booking_unlock_confirm_title({ year: data.year })}
            </AlertDialogTitle>
            <AlertDialogDescription>{m.booking_unlock_confirm_body()}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={unlockMutation.isPending}>
              {m.common_cancel()}
            </AlertDialogCancel>
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
    </section>
  )
}
