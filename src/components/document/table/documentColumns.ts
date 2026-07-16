import type { ColumnDef } from '@tanstack/react-table'
import {
  type DocumentRow,
  documentDisplayName,
  fileKindLabel,
} from '~/components/document/shared/documentHelpers'
import { m } from '~/paraglide/messages'

export const PAGE_SIZES = [20, 50, 100]

// Secondary columns reveal in two tiers as the viewport widens: Storlek +
// Uppladdad at `md`, Typ + Ägare at `lg`. Whatever isn't yet a column reappears
// as a muted sub-line under the filename, so nothing is lost on narrow screens.
// The table is `table-fixed` so these explicit widths let the Namn column
// absorb the remaining space (and truncate) instead of overflowing. Shared by
// the document, folder, and up rows so they all use the same column grid.
export const KIND_CELL = 'hidden w-40 lg:table-cell'
export const OWNER_CELL = 'hidden w-40 lg:table-cell'
export const DATE_CELL = 'hidden w-28 md:table-cell'
export const SIZE_CELL = 'hidden w-24 md:table-cell'

// Only the sortable data columns live in the table model. The actions menu is
// rendered per row (it needs row-level dialog state), so it isn't a column def.
// `header` holds a message function rather than a string: module scope
// evaluates once per process, but the active locale is per request/render.
export const columns: Array<ColumnDef<DocumentRow>> = [
  {
    id: 'name',
    accessorFn: (d) => documentDisplayName(d),
    header: m.document_col_name,
    sortingFn: 'text',
  },
  {
    id: 'kind',
    accessorFn: (d) => fileKindLabel(d),
    header: m.document_col_kind,
    sortingFn: 'text',
  },
  {
    id: 'uploadedAt',
    accessorFn: (d) => d.uploadedAt,
    header: m.document_col_uploaded,
    sortingFn: 'datetime',
  },
  {
    id: 'ownerName',
    accessorFn: (d) => d.ownerName,
    header: m.document_col_owner,
    sortingFn: 'text',
  },
  {
    id: 'sizeBytes',
    accessorFn: (d) => d.sizeBytes,
    header: m.document_col_size,
    sortingFn: 'basic',
  },
]
