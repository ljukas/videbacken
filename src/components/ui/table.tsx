import type * as React from 'react'

import { cn } from '~/lib/utils'

function Table({
  className,
  containerClassName,
  ...props
}: React.ComponentProps<'table'> & { containerClassName?: string }) {
  return (
    <div
      data-slot="table-container"
      className={cn('relative w-full overflow-x-auto', containerClassName)}
    >
      <table
        data-slot="table"
        className={cn('w-full caption-bottom border-separate border-spacing-0 text-sm', className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  // Only border that survives the borderless restyle: a hairline under the
  // header cells (on `th`, since row borders don't render under border-separate).
  return <thead data-slot="table-header" className={cn('[&_th]:border-b', className)} {...props} />
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return <tbody data-slot="table-body" className={className} {...props} />
}

function TableFooter({ className, ...props }: React.ComponentProps<'tfoot'>) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn('border-t bg-muted/50 font-medium [&>tr]:last:border-b-0', className)}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      // Borderless Linear look: the row only drives a `--row-bg` custom property
      // by state; the cells paint it (so it can be rounded — a `<tr>` ignores
      // border-radius). `group/row` also powers RowActions' hover-reveal.
      className={cn(
        'group/row hover:[--row-bg:var(--muted)] has-aria-expanded:[--row-bg:var(--muted)] data-[state=selected]:[--row-bg:var(--muted)]',
        className,
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        'h-10 whitespace-nowrap px-2 text-left align-middle font-medium text-foreground [&:has([role=checkbox])]:pr-0',
        className,
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return (
    <td
      data-slot="table-cell"
      // Each body cell paints the row's `--row-bg`; the end cells round the pill's
      // outer corners via --row-rt/--row-rb (rules in app.css), and adjacent
      // selected rows flatten their shared edge to merge into one rounded block.
      className={cn(
        'whitespace-nowrap bg-[var(--row-bg,transparent)] p-2 align-middle transition-colors [&:has([role=checkbox])]:pr-0',
        className,
      )}
      {...props}
    />
  )
}

function TableCaption({ className, ...props }: React.ComponentProps<'caption'>) {
  return (
    <caption
      data-slot="table-caption"
      className={cn('mt-4 text-muted-foreground text-sm', className)}
      {...props}
    />
  )
}

export { Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow }
