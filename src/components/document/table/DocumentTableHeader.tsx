import type { Column, Table } from '@tanstack/react-table'
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from 'lucide-react'
import type { DocumentRow } from '~/components/document/shared/documentHelpers'
import {
  DATE_CELL,
  KIND_CELL,
  OWNER_CELL,
  SIZE_CELL,
} from '~/components/document/table/documentColumns'
import { Button } from '~/components/ui/button'
import { TableHead, TableHeader, TableRow } from '~/components/ui/table'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'

export function DocumentTableHeader({ table }: { table: Table<DocumentRow> }) {
  return (
    <TableHeader className="sticky top-0 z-10 bg-surface-page">
      <TableRow>
        <SortableHead
          column={table.getColumn('name')}
          label={m.document_col_name()}
          className="w-full"
        />
        <SortableHead
          column={table.getColumn('kind')}
          label={m.document_col_kind()}
          className={KIND_CELL}
        />
        <SortableHead
          column={table.getColumn('uploadedAt')}
          label={m.document_col_uploaded()}
          className={DATE_CELL}
        />
        <SortableHead
          column={table.getColumn('ownerName')}
          label={m.document_col_owner()}
          className={OWNER_CELL}
        />
        <SortableHead
          column={table.getColumn('sizeBytes')}
          label={m.document_col_size()}
          align="end"
          className={SIZE_CELL}
        />
        <TableHead className="w-10">
          <span className="sr-only">{m.document_col_actions()}</span>
        </TableHead>
      </TableRow>
    </TableHeader>
  )
}

function SortableHead({
  column,
  label,
  align = 'start',
  className,
}: {
  column: Column<DocumentRow> | undefined
  label: string
  align?: 'start' | 'end'
  className?: string
}) {
  if (!column) return null
  const sorted = column.getIsSorted()
  const Icon = sorted === 'asc' ? ArrowUpIcon : sorted === 'desc' ? ArrowDownIcon : ArrowUpDownIcon
  return (
    <TableHead
      aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}
      className={className}
    >
      <Button
        variant="ghost"
        size="sm"
        className={cn('-ml-2 h-8 text-muted-foreground', align === 'end' && '-mr-2 ml-auto')}
        onClick={() => column.toggleSorting()}
      >
        {label}
        <Icon data-icon="inline-end" className="text-muted-foreground" />
      </Button>
    </TableHead>
  )
}
