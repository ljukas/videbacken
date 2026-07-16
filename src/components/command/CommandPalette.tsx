import { useHotkey } from '@tanstack/react-hotkeys'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useMemo, useState } from 'react'
import { NAVIGATE_COMMANDS } from '~/components/command/commands'
import { useCommandPalette } from '~/components/command/useCommandPalette'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '~/components/ui/command'
import { m } from '~/paraglide/messages'

const KEYWORD_SPLIT = /\s+/

// Rank a static command against the (lowercased) query so a label match beats a
// keyword-synonym match: label prefix > label substring > keyword-word prefix >
// keyword substring. Keeps e.g. "Konto" above other entries for "kont" — matches
// only via a keyword synonym. 0 = no match (filtered out).
function scoreNavCommand(label: string, keywords: string, q: string): number {
  if (label.startsWith(q)) return 4
  if (label.includes(q)) return 3
  if (keywords.split(KEYWORD_SPLIT).some((word) => word.startsWith(q))) return 2
  if (keywords.includes(q)) return 1
  return 0
}

/**
 * The single global command palette (ADR-0014 / redesign plan 04). A
 * navigation tool: the static route group filtered instantly against the
 * query + its localized keyword synonyms. This component is the sole `Mod+K`
 * owner; the open state lives in `CommandPaletteProvider` so the sidebar/
 * header triggers can share it.
 */
export function CommandPalette({ role }: { role?: string | null }) {
  const navigate = useNavigate()
  const { open, setOpen } = useCommandPalette()

  const [query, setQuery] = useState('')
  // cmdk keeps the previously highlighted item across searches and scrolls it
  // into view, leaving a new result set mid-scroll. We control the selected value
  // and clear it on every edit so cmdk re-picks (and scrolls to) the first item.
  const [selected, setSelected] = useState('')

  // Cmd/Ctrl+K toggles the palette. `Mod` resolves to ⌘ on macOS, Ctrl
  // elsewhere; preventDefault is on by default. Functional update so the binding
  // never closes over a stale `open`.
  const toggle = useCallback(() => setOpen((o) => !o), [setOpen])
  useHotkey('Mod+K', toggle)

  const isAdmin = role === 'admin'
  const visibleCommands = useMemo(
    () => NAVIGATE_COMMANDS.filter((c) => !c.adminOnly || isAdmin),
    [isAdmin],
  )

  // Static group self-filters (cmdk filtering is off): score each command over
  // its localized label + keyword synonyms, drop non-matches, sort best-first
  // (stable, so registry order breaks ties). Empty query → the full launcher list.
  const q = query.trim().toLowerCase()
  const navMatches = q
    ? visibleCommands
        .map((command) => ({
          command,
          score: scoreNavCommand(
            command.label().toLowerCase(),
            command.keywords().toLowerCase(),
            q,
          ),
        }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((entry) => entry.command)
    : visibleCommands

  const showNoResults = q.length > 0 && navMatches.length === 0

  const close = useCallback(() => setOpen(false), [setOpen])

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setQuery('')
          setSelected('')
        }
      }}
      title={m.cmd_title()}
      description={m.cmd_description()}
      className="sm:max-w-xl"
    >
      <Command shouldFilter={false} value={selected} onValueChange={setSelected}>
        <CommandInput
          value={query}
          onValueChange={(value) => {
            setQuery(value)
            setSelected('')
          }}
          placeholder={m.cmd_input_placeholder()}
        />
        <CommandList>
          {showNoResults ? <CommandEmpty>{m.search_no_results()}</CommandEmpty> : null}

          {navMatches.length > 0 ? (
            <CommandGroup heading={m.cmd_group_navigate()}>
              {navMatches.map((command) => (
                <CommandItem
                  key={command.to}
                  value={`nav:${command.to}`}
                  onSelect={() => {
                    close()
                    void navigate({ to: command.to })
                  }}
                >
                  <command.icon data-icon="inline-start" />
                  <span className="truncate">{command.label()}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
