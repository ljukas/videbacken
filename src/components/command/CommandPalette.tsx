import { useHotkey } from '@tanstack/react-hotkeys'
import { useDebouncedValue } from '@tanstack/react-pacer'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { FolderIcon } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { NAVIGATE_COMMANDS } from '~/components/command/commands'
import { useCommandPalette } from '~/components/command/useCommandPalette'
import { fileTypeAppearance, folderPathToSplat } from '~/components/document/shared/documentHelpers'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '~/components/ui/command'
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'

const KEYWORD_SPLIT = /\s+/

// Rank a static command against the (lowercased) query so a label match beats a
// keyword-synonym match: label prefix > label substring > keyword-word prefix >
// keyword substring. Keeps "Konto" above "Delägare" for "kont" — the latter only
// matches via its "kontakter" synonym. 0 = no match (filtered out).
function scoreNavCommand(label: string, keywords: string, q: string): number {
  if (label.startsWith(q)) return 4
  if (label.includes(q)) return 3
  if (keywords.split(KEYWORD_SPLIT).some((word) => word.startsWith(q))) return 2
  if (keywords.includes(q)) return 1
  return 0
}

/**
 * The single global command palette (ADR-0014 / redesign plan 04). Primarily a
 * navigation tool: a static route group filtered instantly, plus server-side
 * folder + document search lifted from the former `DocumentSearch`. Everything
 * navigates — document hits go to their containing folder (with a `?focus` flash)
 * rather than opening the file. This component is the sole `Mod+K` owner; the
 * open state lives in `CommandPaletteProvider` so the sidebar/header triggers can
 * share it.
 */
export function CommandPalette({ role }: { role?: string | null }) {
  const navigate = useNavigate()
  const { open, setOpen } = useCommandPalette()

  const [query, setQuery] = useState('')
  // `query` drives the navigate filter immediately; Pacer derives `debounced`
  // 250ms after the last keystroke (trailing edge) and gates the server search.
  const [debounced] = useDebouncedValue(query, { wait: 250 })
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

  const { data: hits = [], isFetching } = useQuery({
    ...orpc.documentSearch.search.queryOptions({ input: { q: debounced } }),
    enabled: open && debounced.length >= 2,
    // Keep previous hits on screen while a new query loads so results don't flash
    // blank between keystrokes.
    placeholderData: keepPreviousData,
  })

  const folders = hits.filter((h) => h.kind === 'folder')
  const documents = hits.filter((h) => h.kind === 'document')

  // "No results" only once a search has settled with nothing on either side.
  const showNoResults = q.length > 0 && navMatches.length === 0 && hits.length === 0 && !isFetching

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
          loading={isFetching}
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

          {folders.length > 0 ? (
            <CommandGroup heading={m.search_group_folders()}>
              {folders.map((hit) => (
                <CommandItem
                  key={`folder:${hit.id}`}
                  value={`folder:${hit.id}`}
                  onSelect={() => {
                    close()
                    void navigate({
                      to: '/documents/$',
                      params: { _splat: folderPathToSplat(hit.path ?? '') },
                    })
                  }}
                >
                  <FolderIcon data-icon="inline-start" />
                  <span className="truncate">{hit.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}

          {documents.length > 0 ? (
            <CommandGroup heading={m.search_group_documents()}>
              {documents.map((hit) => {
                const { Icon, className } = fileTypeAppearance({
                  mime: hit.mime,
                  extension: hit.extension,
                })
                return (
                  <CommandItem
                    key={`document:${hit.id}`}
                    value={`document:${hit.id}`}
                    onSelect={() => {
                      close()
                      // Navigate to the document's containing folder (there is no
                      // per-document route) and flag it for the focus flash. A
                      // null path means the document lives in the virtual root.
                      const splat = hit.path ? folderPathToSplat(hit.path) : null
                      if (splat) {
                        void navigate({
                          to: '/documents/$',
                          params: { _splat: splat },
                          search: { focus: hit.id },
                        })
                      } else {
                        void navigate({ to: '/documents', search: { focus: hit.id } })
                      }
                    }}
                  >
                    <Icon data-icon="inline-start" className={className} />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate">{hit.name}</span>
                      {hit.path ? (
                        <span className="truncate text-muted-foreground text-sm">{hit.path}</span>
                      ) : null}
                    </div>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          ) : null}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
