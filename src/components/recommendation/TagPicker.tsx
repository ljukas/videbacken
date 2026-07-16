import { useQuery } from '@tanstack/react-query'
import { Badge } from '~/components/ui/badge'
import { orpc } from '~/lib/orpc/client'
import { cn } from '~/lib/utils'
import { isTagSlug, tagLabels } from './tagLabels'

// Multi-select over the fixed, seeded tag set. `value`/`onChange` carry tag IDs
// (what create/update want); labels come from tagLabels[slug](). Tags are loaded
// in the route loader, so this query is warm. Renders Badge chips: unselected =
// outline, selected = the app's canonical `--selected` blue fill (same token as
// selected document/folder cards) for unmistakable contrast.
export function TagPicker({
  value,
  onChange,
}: {
  value: string[]
  onChange: (ids: string[]) => void
}) {
  const { data: tags } = useQuery(orpc.tag.list.queryOptions())
  return (
    <div className="flex flex-wrap gap-2">
      {(tags ?? []).map((t) => {
        const selected = value.includes(t.id)
        return (
          <Badge key={t.id} asChild variant="outline">
            <button
              type="button"
              aria-pressed={selected}
              onClick={() =>
                onChange(selected ? value.filter((id) => id !== t.id) : [...value, t.id])
              }
              className={cn(
                'h-auto cursor-pointer px-3 py-1',
                selected
                  ? 'border-transparent bg-selected text-selected-foreground hover:bg-selected/90'
                  : 'hover:bg-muted hover:text-muted-foreground',
              )}
            >
              {isTagSlug(t.slug) ? tagLabels[t.slug]() : t.slug}
            </button>
          </Badge>
        )
      })}
    </div>
  )
}
