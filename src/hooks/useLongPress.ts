import { useCallback, useEffect, useRef } from 'react'

/**
 * Press-and-hold gesture for touch UIs, where long-press enters the documents
 * "select mode". dnd-kit's `TouchSensor` used to provide this on desktop, but
 * the mobile tree has no `DndContext`, so we detect it directly from pointer
 * events: a press that stays put for `delay` ms fires `onLongPress`; any move
 * beyond `moveTolerance` (a scroll) or an early release cancels it.
 *
 * A quick tap never fires it, so the card's own `onClick` (tap-to-open / toggle)
 * still works. After a long-press fires, the synthetic click that follows the
 * release is suppressed by checking `didLongPress()` in the click handler — the
 * flag is reset on the next press. The native long-press context menu / callout
 * is suppressed via the returned `onContextMenu`.
 */
export function useLongPress(
  onLongPress: () => void,
  opts?: { delay?: number; moveTolerance?: number },
) {
  const { delay = 500, moveTolerance = 10 } = opts ?? {}
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const fired = useRef(false)
  const onLongPressRef = useRef(onLongPress)
  onLongPressRef.current = onLongPress

  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    start.current = null
  }, [])

  // Drop a pending timer if the card unmounts mid-press.
  useEffect(() => clear, [clear])

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return // ignore secondary buttons
      fired.current = false
      start.current = { x: e.clientX, y: e.clientY }
      timer.current = setTimeout(() => {
        fired.current = true
        timer.current = null
        onLongPressRef.current()
      }, delay)
    },
    [delay],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!start.current) return
      const dx = e.clientX - start.current.x
      const dy = e.clientY - start.current.y
      if (dx * dx + dy * dy > moveTolerance * moveTolerance) clear()
    },
    [clear, moveTolerance],
  )

  // Suppress the browser's own long-press menu/callout so it can't race ours.
  const onContextMenu = useCallback((e: React.MouseEvent) => e.preventDefault(), [])

  const didLongPress = useCallback(() => fired.current, [])

  return {
    longPressHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: clear,
      onPointerLeave: clear,
      onPointerCancel: clear,
      onContextMenu,
    },
    didLongPress,
  }
}
