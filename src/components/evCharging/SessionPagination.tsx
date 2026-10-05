import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { useId } from 'react'
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
// page links. The parent owns the page (in the URL) and passes the page it
// actually shows. Hidden while every session fits on the smallest page, since
// there is nothing to page or resize then. The pieces wrap onto their own rows
// on a phone, where the numbered links give way to "Sida 3 av 22".
export function SessionPagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
}: {
  page: number
  pageSize: SessionPageSize
  total: number
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: SessionPageSize) => void
}) {
  const sizeId = useId()
  if (total <= SESSION_PAGE_SIZES[0]) return null

  const count = pageCount(total, pageSize)
  const from = (page - 1) * pageSize + 1
  const to = Math.min(page * pageSize, total)

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
      <p className="mr-auto text-muted-foreground text-sm tabular-nums">
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
          onValueChange={(v) => onPageSizeChange(Number(v) as SessionPageSize)}
        >
          <SelectTrigger id={sizeId} size="sm" className="w-auto">
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
        className="mx-0 ml-auto w-auto"
      >
        <PaginationContent>
          <PaginationItem>
            <Button
              variant="ghost"
              size="icon"
              aria-label={m.charging_sessions_pagination_previous()}
              disabled={page <= 1}
              onClick={() => onPageChange(page - 1)}
            >
              <ChevronLeftIcon />
            </Button>
          </PaginationItem>
          {pageItems(page, count).map((item, i) =>
            item === 'ellipsis' ? (
              // At most one ellipsis per side: right after page 1, or right before the last.
              <PaginationItem
                key={i === 1 ? 'gap-start' : 'gap-end'}
                className="hidden sm:list-item"
              >
                <PaginationEllipsis />
              </PaginationItem>
            ) : (
              <PaginationItem key={item} className="hidden sm:list-item">
                <Button
                  variant={item === page ? 'outline' : 'ghost'}
                  size="icon"
                  className="tabular-nums"
                  aria-label={m.charging_sessions_pagination_page({ page: item })}
                  aria-current={item === page ? 'page' : undefined}
                  onClick={item === page ? undefined : () => onPageChange(item)}
                >
                  {item}
                </Button>
              </PaginationItem>
            ),
          )}
          <PaginationItem className="px-2 text-sm tabular-nums sm:hidden">
            {m.charging_sessions_pagination_position({ page, count })}
          </PaginationItem>
          <PaginationItem>
            <Button
              variant="ghost"
              size="icon"
              aria-label={m.charging_sessions_pagination_next()}
              disabled={page >= count}
              onClick={() => onPageChange(page + 1)}
            >
              <ChevronRightIcon />
            </Button>
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  )
}
