import { useCallback, useRef } from 'react'

type ClickModifiers = { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }

/**
 * Click-to-select for a row list (OS file-browser semantics), driving a
 * `Set<string>` of selected ids held by the parent:
 *   - plain click → select only that row (and set the range anchor),
 *   - Cmd/Ctrl-click → toggle that row in/out of the selection,
 *   - Shift-click → select the inclusive range from the anchor to the row.
 *
 * `orderedIds` is the *visible* row order (post sort + pagination). The range is
 * therefore page-local; if the anchor isn't on the current page the shift-click
 * degrades to a plain click. Called inside the table, where the order is known.
 */
export function useRowSelection({
  orderedIds,
  selected,
  setSelected,
}: {
  orderedIds: Array<string>
  selected: Set<string>
  setSelected: (next: Set<string>) => void
}) {
  const anchorRef = useRef<string | null>(null)

  const onRowClick = useCallback(
    (id: string, mods: ClickModifiers) => {
      if (mods.shiftKey && anchorRef.current) {
        const a = orderedIds.indexOf(anchorRef.current)
        const b = orderedIds.indexOf(id)
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a <= b ? [a, b] : [b, a]
          setSelected(new Set(orderedIds.slice(lo, hi + 1)))
          return
        }
        // Anchor scrolled off the current page — fall through to a plain click.
      }
      if (mods.metaKey || mods.ctrlKey) {
        const next = new Set(selected)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        setSelected(next)
        anchorRef.current = id
        return
      }
      setSelected(new Set([id]))
      anchorRef.current = id
    },
    [orderedIds, selected, setSelected],
  )

  return { onRowClick }
}
