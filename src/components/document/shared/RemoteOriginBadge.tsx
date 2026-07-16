import { Badge } from '~/components/ui/badge'

/**
 * Marker for a document whose bytes belong to production, surfaced through a
 * branched dev/preview DB. Rendered when the row's `isRemoteOrigin` flag is set,
 * which `listDocuments` computes server-side and is false in production — so this
 * never appears to real users. The message differs by environment: in local dev
 * the byte may be missing until `pnpm storage:sync`; in preview it renders from
 * the shared prod store but is read-only (deletes/renames here can't touch it).
 * English literal on purpose: a developer diagnostic, never a localized string.
 */
export function RemoteOriginBadge() {
  const title = import.meta.env.DEV
    ? "Uploaded in production — bytes aren't in local dev storage. Run `pnpm storage:sync`."
    : 'Production file, shown from the shared production store. Deletes and renames here do not affect the original.'
  return (
    <Badge
      variant="outline"
      className="h-4 border-amber-500/40 px-1 font-mono text-[10px] text-amber-600 dark:text-amber-500"
      title={title}
    >
      PROD
    </Badge>
  )
}
