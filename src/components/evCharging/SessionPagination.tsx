import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { type ReactNode, useId } from 'react'
import { Button } from '~/components/ui/button'
import { Label } from '~/components/ui/label'
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
} from '~/components/ui/pagination'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import {
  pageCount,
  pageItems,
  SESSION_PAGE_SIZES,
  type SessionPageSize,
} from '~/lib/evCharging/paging'
import { m } from '~/paraglide/messages'
import { formatCount } from './format'

// Paging for a session list: which rows are on screen, rows per page, and the
// page links. The parent owns the page (in the URL); a page past the end is
// shown as the last one. Hidden while every session fits on the smallest page,
// since there is nothing to page or resize then. The pieces wrap onto their own
// rows on a phone, where the numbered links give way to "Sida 3 av 22".
export function SessionPagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
}: {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: SessionPageSize) => void
}) {
  const sizeId = useId()
  if (total <= SESSION_PAGE_SIZES[0]) return null

  const count = pageCount(total, pageSize)
  const current = Math.min(Math.max(page, 1), count)
  const from = (current - 1) * pageSize + 1
  const to = Math.min(current * pageSize, total)

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
      {/* A status, so a page change is announced while focus stays on the control. */}
      <p role="status" className="mr-auto text-muted-foreground text-sm tabular-nums">
        {m.charging_sessions_pagination_range({
          from: formatCount(from),
          to: formatCount(to),
          total: formatCount(total),
        })}
      </p>
      <div className="flex items-center gap-2">
        <Label htmlFor={sizeId} className="whitespace-nowrap font-normal text-muted-foreground">
          {m.charging_sessions_pagination_page_size()}
        </Label>
        <Select
          value={String(pageSize)}
          onValueChange={(v) => {
            const size = SESSION_PAGE_SIZES.find((s) => String(s) === v)
            if (size) onPageSizeChange(size)
          }}
        >
          {/* A 44 px target under a finger (the size variant would win without the !). */}
          <SelectTrigger id={sizeId} size="sm" className="pointer-coarse:h-11! w-auto">
            {/* Rendered explicitly so SSR already shows the size (Radix fills it in
                only after hydration). */}
            <SelectValue>{pageSize}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {SESSION_PAGE_SIZES.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <Pagination
        aria-label={m.charging_sessions_pagination_label()}
        className="mx-0 ml-auto max-sm:w-full sm:w-auto"
      >
        <PaginationContent className="max-sm:w-full max-sm:justify-between">
          <PaginationItem>
            <StepButton
              label={m.charging_sessions_pagination_previous()}
              unavailable={current <= 1}
              onClick={() => onPageChange(current - 1)}
            >
              <ChevronLeftIcon />
            </StepButton>
          </PaginationItem>
          {pageItems(current, count).map((item, i) =>
            item === 'ellipsis' ? (
              // At most one ellipsis per side: right after page 1, or right before the last.
              <PaginationItem
                key={i === 1 ? 'gap-start' : 'gap-end'}
                aria-hidden
                className="hidden sm:list-item"
              >
                <PaginationEllipsis />
              </PaginationItem>
            ) : (
              <PaginationItem key={item} className="hidden sm:list-item">
                {/* Named by its number alone; the nav's label says what it pages. */}
                <Button
                  variant={item === current ? 'outline' : 'ghost'}
                  size="icon"
                  className="pointer-coarse:size-11 tabular-nums"
                  aria-current={item === current ? 'page' : undefined}
                  onClick={item === current ? undefined : () => onPageChange(item)}
                >
                  {item}
                </Button>
              </PaginationItem>
            ),
          )}
          {/* A fixed width, so the arrows don't shift between "Sida 9" and "Sida 10". */}
          <PaginationItem className="min-w-28 px-2 text-center text-sm tabular-nums sm:hidden">
            {m.charging_sessions_pagination_position({ page: current, count })}
          </PaginationItem>
          <PaginationItem>
            <StepButton
              label={m.charging_sessions_pagination_next()}
              unavailable={current >= count}
              onClick={() => onPageChange(current + 1)}
            >
              <ChevronRightIcon />
            </StepButton>
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  )
}

// Previous/next. At either end it is aria-disabled rather than disabled: a
// focused button that turns `disabled` drops focus to <body>, so stepping onto
// the last page would lose a keyboard user's place. A 44 px target under a
// finger, like every button in the control.
function StepButton({
  label,
  unavailable,
  onClick,
  children,
}: {
  label: string
  unavailable: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="pointer-coarse:size-11 aria-disabled:pointer-events-none aria-disabled:opacity-50"
      aria-label={label}
      aria-disabled={unavailable || undefined}
      onClick={unavailable ? undefined : onClick}
    >
      {children}
    </Button>
  )
}
