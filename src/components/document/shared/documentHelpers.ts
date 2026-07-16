import {
  FileArchiveIcon,
  FileIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileTypeIcon,
  type LucideIcon,
  PresentationIcon,
  SheetIcon,
} from 'lucide-react'
import type { RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { getLocale } from '~/paraglide/runtime'
import { joinFilename } from '~/utils/filename'

// Row shapes derived from the router — no hand-maintained duplicates.
export type DocumentRow = RouterOutputs['document']['listDocuments'][number]
export type FolderRow = RouterOutputs['folder']['tree'][number]
export type BinEntry = RouterOutputs['bin']['list'][number]

/**
 * Split flat bin entries into restorable groups. Cascade deletes share a
 * `correlationId` → one batch restored together; entries without one were
 * deleted individually → `loose`, restored/purged per item. Insertion order is
 * preserved (Map keeps first-seen order; `loose` keeps array order), so the
 * rendered list mirrors the server's ordering.
 */
export function partitionBinEntries(entries: ReadonlyArray<BinEntry>): {
  batches: Map<string, Array<BinEntry>>
  loose: Array<BinEntry>
} {
  const batches = new Map<string, Array<BinEntry>>()
  const loose: Array<BinEntry> = []
  for (const entry of entries) {
    if (entry.correlationId) {
      const list = batches.get(entry.correlationId) ?? []
      list.push(entry)
      batches.set(entry.correlationId, list)
    } else {
      loose.push(entry)
    }
  }
  return { batches, loose }
}

/**
 * Full filename for display: the stored base `name` plus its `.extension`.
 * The two are stored separately so the extension can't be renamed; rejoin
 * them everywhere a document name is shown.
 */
export function documentDisplayName(doc: { name: string; extension?: string | null }): string {
  return joinFilename(doc)
}

export type CurrentUser = { id: string; role?: string | null }

/**
 * Date + time line ("26 maj 2026 14:32"-style) for history rows and the bin.
 * Resolved per call, not at module scope — a module-level formatter would pin
 * the first request's locale for the whole server process. UI locale `en` maps
 * to en-GB, mirroring `~/lib/i18n/format`.
 */
export function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat(getLocale() === 'sv' ? 'sv-SE' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Strip the leading/trailing slashes off a stored folder `path`
 * (`/Manuals/Engine/` → `Manuals/Engine`) to feed the `/documents/$` splat.
 * The router percent-encodes each segment, so pass the raw (decoded) string.
 */
export function folderPathToSplat(path: string): string {
  return path.replace(/^\/+|\/+$/g, '')
}

/**
 * Human-readable breadcrumb for the *parent* location a folder lived in, derived
 * from its own denormalized `path` (e.g. `/Manuals/Drift/Engine/`). Drops the
 * folder's own trailing segment and joins the ancestors, rooted at `Hem`:
 * `/Manuals/Drift/Engine/` → `Hem / Manuals / Drift`; `/Reports/` → `Hem`.
 *
 * Reads the stored path verbatim, so it stays correct for a deleted folder even
 * if its ancestors were later removed.
 */
export function folderParentBreadcrumb(path: string): string {
  const root = m.folder_root_name()
  const parents = path.split('/').filter(Boolean).slice(0, -1)
  return parents.length ? `${root} / ${parents.join(' / ')}` : root
}

/**
 * Resolve a decoded `/documents/$` splat (`Manuals/Engine`) to its folder by
 * matching the stored `path` column in the flat tree. Returns null for the
 * empty splat (root) or a path that no longer exists (renamed/moved/deleted).
 *
 * Both sides are NFC-normalized: encode/decode is byte-faithful and won't
 * reconcile precomposed vs decomposed å/ä/ö, so a bare `===` could miss. This
 * is a read-time guard only — no migration.
 */
export function resolveFolderBySplat(
  folders: Array<FolderRow>,
  splat: string | undefined,
): FolderRow | null {
  if (!splat) return null
  const trimmed = splat.replace(/^\/+|\/+$/g, '')
  if (trimmed === '') return null
  const target = `/${trimmed}/`.normalize('NFC')
  return folders.find((f) => f.path.normalize('NFC') === target) ?? null
}

/**
 * Breadcrumb trail (root → current) for a folder id, resolved against the flat
 * tree. Returns [] for the virtual root. Walks `parentId` up from the target.
 */
export function folderTrail(folders: Array<FolderRow>, folderId: string | null): Array<FolderRow> {
  if (!folderId) return []
  const byId = new Map(folders.map((f) => [f.id, f]))
  const trail: Array<FolderRow> = []
  let current = byId.get(folderId)
  // Guard against a malformed cycle with a depth cap.
  for (let i = 0; current && i < 64; i += 1) {
    trail.unshift(current)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return trail
}

// dnd-kit droppable/draggable id helpers — keep the string scheme in one place.
export const ROOT_DROP_ID = 'folder:root'
export const folderDropId = (folderId: string) => `folder:${folderId}`
export const documentDragId = (documentId: string) => `document:${documentId}`
// A folder row is both draggable and droppable; the drag id uses a distinct
// prefix from its `folder:` drop id. The drag carries `data: { folderId }`, so
// handlers read the data rather than parsing this id.
export const folderDragId = (folderId: string) => `folder-drag:${folderId}`

/**
 * Droppable id for the "up one level" chip. Distinct `up:` prefix so it never
 * collides with the parent/root droppable the breadcrumb already registers —
 * dnd-kit ids must be unique. Resolves to the same target as the folder ids.
 */
export const folderUpDropId = (parentId: string | null) =>
  parentId === null ? 'up:root' : `up:${parentId}`

/** Parse a droppable id back to a target folderId (null = root), or undefined. */
export function parseFolderDropId(id: string): string | null | undefined {
  if (id === ROOT_DROP_ID || id === 'up:root') return null
  if (id.startsWith('up:')) return id.slice('up:'.length)
  if (id.startsWith('folder:')) return id.slice('folder:'.length)
  return undefined
}

// Selection keys — a separate namespace from the dnd drop ids above. The
// documents table holds one `Set<string>` of these composite keys so files and
// folders share a single selection (range, toggle, anchor) without
// discriminating. Distinct `seldoc:` / `selfolder:` prefixes so a selection key
// can never be mistaken for a dnd drop id (`folder:<id>`) by `parseFolderDropId`.
export const SEL_DOC_PREFIX = 'seldoc:'
export const SEL_FOLDER_PREFIX = 'selfolder:'
export const seldocKey = (documentId: string) => `${SEL_DOC_PREFIX}${documentId}`
export const selfolderKey = (folderId: string) => `${SEL_FOLDER_PREFIX}${folderId}`

/** Parse a selection key back to its kind + id, or undefined for a stray key. */
export function parseSelKey(key: string): { kind: 'document' | 'folder'; id: string } | undefined {
  if (key.startsWith(SEL_DOC_PREFIX))
    return { kind: 'document', id: key.slice(SEL_DOC_PREFIX.length) }
  if (key.startsWith(SEL_FOLDER_PREFIX))
    return { kind: 'folder', id: key.slice(SEL_FOLDER_PREFIX.length) }
  return undefined
}

/** A drop target folder id, or null for the root. */
export type DropTarget = string | null

/**
 * What a drag-end resolves to. `single-*` keeps the legacy single-item move
 * paths (their nicer singular toasts); `mixed` moves the whole selection;
 * `abort` is an illegal group drop (into a folder being moved); `none` is a
 * no-op (nothing left to move after filtering).
 */
export type MixedDropPlan =
  | { kind: 'none' }
  | { kind: 'abort' }
  | { kind: 'single-doc'; id: string }
  | { kind: 'single-folder'; id: string }
  | { kind: 'mixed'; docIds: Array<string>; folderIds: Array<string> }

/**
 * A folder move is legal when it isn't a no-op or a cycle: not onto itself, not
 * back into its current parent, and not into its own subtree (which would orphan
 * the branch). Mirrors the guards the `folder.moveFolder` service also enforces.
 */
function isFolderMoveLegal(
  folder: FolderRow | undefined,
  target: DropTarget,
  folders: ReadonlyArray<FolderRow>,
): boolean {
  if (!folder) return false
  if (target === folder.id) return false
  if ((folder.parentId ?? null) === target) return false
  const targetFolder = target === null ? null : folders.find((f) => f.id === target)
  if (targetFolder?.path.startsWith(folder.path)) return false
  return true
}

/**
 * Pure decision for `onDragEnd`: given the dragged row, the drop target, and the
 * current selection, decide what to move. Dragging a row that's part of the
 * selection moves the whole mixed selection; dragging an unselected row moves
 * just it (today's behaviour). A group drop into a selected folder (or its
 * subtree) is aborted — you can't drop items into a folder you're moving.
 * Folder moves are admin-only, so folder ids are dropped when `!isAdmin`.
 */
export function planMixedDrop({
  dragged,
  target,
  selectedDocIds,
  selectedFolderIds,
  visibleDocuments,
  folders,
  isAdmin,
}: {
  dragged: { kind: 'document' | 'folder'; id: string }
  target: DropTarget
  selectedDocIds: ReadonlyArray<string>
  selectedFolderIds: ReadonlyArray<string>
  visibleDocuments: ReadonlyArray<Pick<DocumentRow, 'id' | 'folderId'>>
  folders: ReadonlyArray<FolderRow>
  isAdmin: boolean
}): MixedDropPlan {
  const draggedSelected =
    dragged.kind === 'document'
      ? selectedDocIds.includes(dragged.id)
      : isAdmin && selectedFolderIds.includes(dragged.id)

  // Unselected row — move just the dragged item, as before.
  if (!draggedSelected) {
    if (dragged.kind === 'document') {
      const doc = visibleDocuments.find((d) => d.id === dragged.id)
      return doc && doc.folderId !== target
        ? { kind: 'single-doc', id: dragged.id }
        : { kind: 'none' }
    }
    const folder = folders.find((f) => f.id === dragged.id)
    return isFolderMoveLegal(folder, target, folders)
      ? { kind: 'single-folder', id: dragged.id }
      : { kind: 'none' }
  }

  // Group drag of the whole selection. Abort if the target is, or sits inside,
  // a selected folder — dropping into a folder you're simultaneously moving.
  const targetFolder = target === null ? null : folders.find((f) => f.id === target)
  const intoSelectedSubtree = selectedFolderIds.some((id) => {
    if (target === id) return true
    const sel = folders.find((f) => f.id === id)
    return !!sel && !!targetFolder && targetFolder.path.startsWith(sel.path)
  })
  if (intoSelectedSubtree) return { kind: 'abort' }

  const docIds = selectedDocIds.filter((id) => {
    const doc = visibleDocuments.find((d) => d.id === id)
    return doc && doc.folderId !== target
  })
  const folderIds = isAdmin
    ? selectedFolderIds.filter((id) =>
        isFolderMoveLegal(
          folders.find((f) => f.id === id),
          target,
          folders,
        ),
      )
    : []

  if (docIds.length + folderIds.length === 0) return { kind: 'none' }
  return { kind: 'mixed', docIds, folderIds }
}

// File-type tile icon + brand color. File-type colors (PDF red, Word blue,
// Excel green, …) are a deliberate exception to the "semantic colors only" rule
// — conventional and instantly recognisable, like the icon-rail tooltips. We map
// known mimes to a family, falling back to the lowercased extension because
// browser uploads sometimes send a generic/empty contentType (ADR-0010 §M: no
// mime whitelist).
type FileFamily = 'pdf' | 'word' | 'excel' | 'csv' | 'presentation' | 'archive' | 'text'

const FAMILY_BY_MIME: Record<string, FileFamily> = {
  'application/pdf': 'pdf',
  'application/msword': 'word',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'word',
  'application/vnd.ms-excel': 'excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'excel',
  'text/csv': 'csv',
  'application/vnd.ms-powerpoint': 'presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'presentation',
  'application/zip': 'archive',
  'application/x-zip-compressed': 'archive',
  'application/vnd.rar': 'archive',
  'application/x-rar-compressed': 'archive',
  'application/x-7z-compressed': 'archive',
  'application/gzip': 'archive',
  'application/x-tar': 'archive',
  'text/plain': 'text',
}

const FAMILY_BY_EXTENSION: Record<string, FileFamily> = {
  pdf: 'pdf',
  doc: 'word',
  docx: 'word',
  xls: 'excel',
  xlsx: 'excel',
  csv: 'csv',
  ppt: 'presentation',
  pptx: 'presentation',
  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  gz: 'archive',
  tar: 'archive',
  txt: 'text',
}

const APPEARANCE_BY_FAMILY: Record<FileFamily, { Icon: LucideIcon; className: string }> = {
  pdf: { Icon: FileTextIcon, className: 'text-red-600 dark:text-red-500' },
  word: { Icon: FileTypeIcon, className: 'text-blue-600 dark:text-blue-500' },
  excel: { Icon: FileSpreadsheetIcon, className: 'text-green-600 dark:text-green-500' },
  // Spreadsheet-family, same green as Excel but a distinct icon — CSVs open in
  // sheet apps yet aren't xlsx workbooks.
  csv: { Icon: SheetIcon, className: 'text-green-600 dark:text-green-500' },
  presentation: { Icon: PresentationIcon, className: 'text-orange-600 dark:text-orange-500' },
  archive: { Icon: FileArchiveIcon, className: 'text-amber-600 dark:text-amber-500' },
  text: { Icon: FileTextIcon, className: 'text-muted-foreground' },
}

const FALLBACK_APPEARANCE = { Icon: FileIcon, className: 'text-muted-foreground' }

/**
 * Icon + color class for a document tile, keyed by mime with an extension
 * fallback. Returns a generic muted file icon for unknown types.
 */
export function fileTypeAppearance(file: { mime: string; extension?: string | null }): {
  Icon: LucideIcon
  className: string
} {
  const family =
    FAMILY_BY_MIME[file.mime.toLowerCase()] ??
    (file.extension ? FAMILY_BY_EXTENSION[file.extension.toLowerCase()] : undefined)
  return family ? APPEARANCE_BY_FAMILY[family] : FALLBACK_APPEARANCE
}

// Human-readable "Kind" labels for the Typ column, Finder-style. The values are
// message *functions*, not strings: module scope evaluates once per process,
// but the active locale is per request/render (same pattern as AppSidebar's nav
// items). The family/subtype/extension keys stay English. We reuse the family
// maps above so type detection lives in one place; archives derive their label
// straight from the extension so a `.rar` reads "RAR-arkiv", not a generic
// "Arkiv".
const KIND_LABEL_BY_FAMILY: Record<Exclude<FileFamily, 'archive'>, () => string> = {
  pdf: m.document_kind_pdf,
  word: m.document_kind_word,
  excel: m.document_kind_excel,
  csv: m.document_kind_csv,
  presentation: m.document_kind_presentation,
  text: m.document_kind_text,
}

// Display name fed into the localized "{name}-bild" label.
const IMAGE_NAME_BY_SUBTYPE: Record<string, string> = {
  jpeg: 'JPEG',
  png: 'PNG',
  gif: 'GIF',
  webp: 'WebP',
  heic: 'HEIC',
  heif: 'HEIC',
  avif: 'AVIF',
  'svg+xml': 'SVG',
  bmp: 'BMP',
  tiff: 'TIFF',
}

/**
 * Swedish, type-specific "Kind" label for the Typ column: "PDF-dokument",
 * "JPEG-bild", "ZIP-arkiv", … Falls back to an extension-derived "IPA-fil" for
 * unknown types, or a bare "Fil" when there's no extension either. Folders are
 * labelled "Mapp" at the row level — they never reach this helper.
 */
export function fileKindLabel(file: { mime: string; extension?: string | null }): string {
  const mime = file.mime.toLowerCase()
  const ext = file.extension?.toLowerCase() ?? ''

  if (mime.startsWith('image/')) {
    const subtype = mime.slice('image/'.length)
    const name = IMAGE_NAME_BY_SUBTYPE[subtype] ?? (ext ? ext.toUpperCase() : undefined)
    return name ? m.document_kind_image_named({ name }) : m.document_kind_image()
  }

  const family = FAMILY_BY_MIME[mime] ?? (ext ? FAMILY_BY_EXTENSION[ext] : undefined)
  if (family === 'archive') {
    return ext
      ? m.document_kind_archive_named({ name: ext.toUpperCase() })
      : m.document_kind_archive()
  }
  if (family) return KIND_LABEL_BY_FAMILY[family]()

  return ext ? m.document_kind_file_named({ name: ext.toUpperCase() }) : m.document_kind_file()
}
