import {
  createContext,
  type Dispatch,
  type PropsWithChildren,
  type SetStateAction,
  use,
  useMemo,
  useState,
} from 'react'

type CommandPaletteContextValue = {
  open: boolean
  setOpen: Dispatch<SetStateAction<boolean>>
}

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null)

/**
 * Holds the single global command-palette open state so the dialog (mounted once
 * in the authenticated shell) and every trigger (sidebar header, documents views)
 * share it. The `Mod+K` hotkey owner lives in `CommandPalette` itself.
 */
export function CommandPaletteProvider({ children }: PropsWithChildren) {
  const [open, setOpen] = useState(false)
  const value = useMemo(() => ({ open, setOpen }), [open])
  return <CommandPaletteContext value={value}>{children}</CommandPaletteContext>
}

export function useCommandPalette(): CommandPaletteContextValue {
  const value = use(CommandPaletteContext)
  if (!value) throw new Error('useCommandPalette must be used within a CommandPaletteProvider')
  return value
}
