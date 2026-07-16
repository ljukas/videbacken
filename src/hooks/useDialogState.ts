import { useCallback, useState } from 'react'

/**
 * Tracks which one of a mutually-exclusive set of dialogs is open, keyed by a
 * string literal union (`null` = none open). Pairs with the "mount only while
 * open" pattern so a row/node doesn't hold live dialog queries until acted on.
 *
 *   const dialog = useDialogState<'rename' | 'move'>()
 *   <Item onSelect={() => dialog.show('rename')} />
 *   {dialog.active === 'rename' ? <RenameDialog onOpenChange={dialog.close} /> : null}
 */
export function useDialogState<T extends string>() {
  const [active, setActive] = useState<T | null>(null)
  const close = useCallback(() => setActive(null), [])
  return { active, show: setActive, close }
}
