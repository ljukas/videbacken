import {
  type Column,
  type ColumnDef,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  LifeBuoyIcon,
  MoreVerticalIcon,
  PencilIcon,
  RotateCcwIcon,
  SailboatIcon,
  SendIcon,
  StarIcon,
  Trash2Icon,
} from 'lucide-react'
import { formatPhoneNumberIntl } from 'react-phone-number-input'
import { Avatar, AvatarBadge, AvatarFallback, AvatarImage } from '~/components/ui/avatar'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '~/components/ui/empty'
import { RowActions } from '~/components/ui/row-actions'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { formatDate, formatDistanceShort } from '~/lib/i18n/format'
import type { UserRow } from '~/lib/services/user'
import type { ShareCode } from '~/lib/shares/codes'
import { shareBackgroundClass } from '~/lib/shares/colors'
import { cn, initials } from '~/lib/utils'
import { m } from '~/paraglide/messages'

export type OwnerRow = UserRow & {
  shares: Array<ShareCode>
  // When the current invite link expires (lastInvitedAt + 7d), or null when the
  // user was never invited. Drives the "Inbjuden — går ut om …" countdown.
  inviteExpiresAt: Date | null
}

type Props = {
  owners: Array<OwnerRow>
  onlineSet: Set<string>
  currentUserId: string
  isAdmin: boolean
  /** Deleted view (admin-only): swaps Telefon→Borttagen, drops Andelar, offers restore. */
  showDeleted: boolean
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onRestore: (id: string) => void
  /** Resend the invite email to a pending owner (active view, admin only). */
  onResendInvite?: (id: string) => void
}

// Secondary columns reveal as the viewport widens: Roll + Andelar at `md`,
// E-post + Telefon at `lg`. Whatever isn't yet a column folds in as a muted
// sub-line under the name, so nothing is lost on narrow screens.
const ROLE_CELL = 'hidden md:table-cell'
const SHARES_CELL = 'hidden md:table-cell'
const EMAIL_CELL = 'hidden lg:table-cell'
const PHONE_CELL = 'hidden lg:table-cell'

function roleLabel(role: string | null): string {
  return role === 'admin' ? m.user_role_admin() : m.user_role_sailor()
}

// Sort key for the Andelar column: the primary (alphabetically first) share.
// Owners with no shares get "~" so they sort last in ascending order.
function primaryShareKey(shares: Array<ShareCode>): string {
  return shares.length === 0 ? '~' : [...shares].sort()[0]
}

// Only the sortable data columns live in the table model (it drives sort state
// and the sorted row order); cells are hand-rendered per row below.
const columns: Array<ColumnDef<OwnerRow>> = [
  { id: 'name', accessorFn: (u) => u.name, header: () => m.user_field_name(), sortingFn: 'text' },
  {
    id: 'role',
    accessorFn: (u) => roleLabel(u.role),
    header: () => m.user_field_role(),
    sortingFn: 'text',
  },
  {
    id: 'shares',
    accessorFn: (u) => primaryShareKey(u.shares),
    header: () => m.owners_header_shares(),
    sortingFn: 'text',
  },
]

export function OwnersTable({
  owners,
  onlineSet,
  currentUserId,
  isAdmin,
  showDeleted,
  onEdit,
  onDelete,
  onRestore,
  onResendInvite,
}: Props) {
  const table = useReactTable({
    data: owners,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    // No initial sorting — the server returns accepted users first, then pending
    // invitees, each by surname; columns become sortable on click (a toggled
    // sort takes over, so the accepted/pending grouping only holds by default).
  })
  const rows = table.getRowModel().rows

  // The active list always holds at least one owner, so only the deleted filter
  // can be empty. It's a happy zero-state (nobody removed), so we lean into the
  // nautical brand: a lifebuoy medallion + warm copy (ADR-0015/0016).
  if (showDeleted && rows.length === 0) {
    return (
      <Empty className="brand-wash rounded-lg border">
        <EmptyHeader>
          <EmptyMedia
            variant="icon"
            className="size-14 rounded-full bg-brand/10 text-brand ring-1 ring-brand/20"
          >
            <LifeBuoyIcon className="size-7" />
          </EmptyMedia>
          <EmptyTitle>{m.owners_empty_deleted_title()}</EmptyTitle>
          <EmptyDescription>{m.owners_empty_deleted_description()}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <Table containerClassName="min-h-0 md:-mx-4">
      <TableHeader className="sticky top-0 z-10 bg-surface-page">
        <TableRow>
          <SortableHead column={table.getColumn('name')} label={m.user_field_name()} />
          <SortableHead
            column={table.getColumn('role')}
            label={m.user_field_role()}
            className={ROLE_CELL}
          />
          <TableHead className={EMAIL_CELL}>{m.user_field_email()}</TableHead>
          <TableHead className={PHONE_CELL}>
            {showDeleted ? m.owners_header_deleted() : m.user_field_phone()}
          </TableHead>
          {showDeleted ? null : (
            <SortableHead
              column={table.getColumn('shares')}
              label={m.owners_header_shares()}
              className={SHARES_CELL}
            />
          )}
          {isAdmin ? (
            <TableHead className="w-10">
              <span className="sr-only">{m.common_actions()}</span>
            </TableHead>
          ) : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <OwnerTableRow
            key={row.original.id}
            owner={row.original}
            isSelf={row.original.id === currentUserId}
            isOnline={onlineSet.has(row.original.id)}
            isAdmin={isAdmin}
            showDeleted={showDeleted}
            onEdit={onEdit}
            onDelete={onDelete}
            onRestore={onRestore}
            onResendInvite={onResendInvite}
          />
        ))}
      </TableBody>
    </Table>
  )
}

function OwnerTableRow({
  owner,
  isSelf,
  isOnline,
  isAdmin,
  showDeleted,
  onEdit,
  onDelete,
  onRestore,
  onResendInvite,
}: {
  owner: OwnerRow
  isSelf: boolean
  isOnline: boolean
  isAdmin: boolean
  showDeleted: boolean
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onRestore: (id: string) => void
  onResendInvite?: (id: string) => void
}) {
  const formattedPhone = owner.phone ? formatPhoneNumberIntl(owner.phone) || owner.phone : null
  const deletedAt = owner.deletedAt ? formatDate(owner.deletedAt) : '—'
  const shares = owner.shares
  // Pending = invited but never signed in. Only meaningful in the active view.
  const isPending = !showDeleted && !owner.emailVerified

  return (
    <TableRow className="group/row">
      <TableCell>
        <div className="flex min-w-0 items-center gap-3">
          <Avatar className="size-9 shrink-0">
            {owner.image ? (
              <AvatarImage
                src={owner.image}
                alt={owner.name}
                width={36}
                height={36}
                blurhash={owner.imageBlurhash}
              />
            ) : null}
            <AvatarFallback>{initials(owner.name)}</AvatarFallback>
            {isOnline ? (
              <AvatarBadge className="size-3 bg-success ring-2">
                <span
                  aria-hidden
                  className="absolute inset-0 animate-ping rounded-full bg-success opacity-75"
                />
                <span className="sr-only">{m.owners_online()}</span>
              </AvatarBadge>
            ) : null}
          </Avatar>

          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate font-medium" title={owner.name}>
                {owner.name || '—'}
              </span>
              {isSelf ? <Badge variant="secondary">{m.owners_badge_you()}</Badge> : null}
              {isPending ? (
                <Badge variant="outline" className="border-brand/30 bg-brand/10 text-brand">
                  {m.user_status_invited()}
                </Badge>
              ) : null}
            </div>

            {/* Countdown is decision-support for resending, which only admins do —
                non-admins see just the "Inbjuden" badge above. */}
            {isPending && isAdmin ? <InviteCountdown expiresAt={owner.inviteExpiresAt} /> : null}

            {/* Roll (+ Andelar) fold in here until they become columns at `md`. */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 md:hidden">
              <RoleLabel role={owner.role} />
              {showDeleted ? null : shares.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {shares.map((code) => (
                    <ShareBadge key={code} code={code} />
                  ))}
                </div>
              ) : null}
            </div>

            {/* E-post + Telefon/Borttagen fold in here until they become columns at `lg`. */}
            <div className="flex flex-col gap-0.5 text-xs lg:hidden">
              <a
                href={`mailto:${owner.email}`}
                className="truncate text-muted-foreground transition-colors hover:text-foreground"
                title={owner.email}
              >
                {owner.email}
              </a>
              {showDeleted ? (
                <span className="text-muted-foreground tabular-nums">
                  {m.owners_deleted_at({ date: deletedAt })}
                </span>
              ) : formattedPhone ? (
                <a
                  href={`tel:${owner.phone}`}
                  className="text-muted-foreground tabular-nums transition-colors hover:text-foreground"
                >
                  {formattedPhone}
                </a>
              ) : null}
            </div>
          </div>
        </div>
      </TableCell>

      <TableCell className={ROLE_CELL}>
        <RoleLabel role={owner.role} />
      </TableCell>

      <TableCell className={EMAIL_CELL}>
        <a
          href={`mailto:${owner.email}`}
          className="text-muted-foreground transition-colors hover:text-foreground"
          title={owner.email}
        >
          {owner.email}
        </a>
      </TableCell>

      <TableCell className={cn(PHONE_CELL, 'text-muted-foreground tabular-nums')}>
        {showDeleted ? (
          deletedAt
        ) : formattedPhone ? (
          <a href={`tel:${owner.phone}`} className="transition-colors hover:text-foreground">
            {formattedPhone}
          </a>
        ) : (
          '—'
        )}
      </TableCell>

      {showDeleted ? null : (
        <TableCell className={SHARES_CELL}>
          {shares.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {shares.map((code) => (
                <ShareBadge key={code} code={code} />
              ))}
            </div>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </TableCell>
      )}

      {isAdmin ? (
        <TableCell className="text-right">
          <RowActions>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={m.owners_actions_for({ name: owner.name })}
                >
                  <MoreVerticalIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {showDeleted ? (
                  <DropdownMenuItem onSelect={() => onRestore(owner.id)}>
                    <RotateCcwIcon />
                    {m.common_restore()}
                  </DropdownMenuItem>
                ) : (
                  <>
                    <DropdownMenuItem onSelect={() => onEdit(owner.id)}>
                      <PencilIcon />
                      {m.common_edit()}
                    </DropdownMenuItem>
                    {isPending && onResendInvite ? (
                      <DropdownMenuItem onSelect={() => onResendInvite(owner.id)}>
                        <SendIcon />
                        {m.user_resend_invite()}
                      </DropdownMenuItem>
                    ) : null}
                    {isSelf ? null : (
                      <DropdownMenuItem variant="destructive" onSelect={() => onDelete(owner.id)}>
                        <Trash2Icon />
                        {m.common_delete()}
                      </DropdownMenuItem>
                    )}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </RowActions>
        </TableCell>
      ) : null}
    </TableRow>
  )
}

function SortableHead({
  column,
  label,
  className,
}: {
  column: Column<OwnerRow> | undefined
  label: string
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
        className="-ml-2 h-8 text-muted-foreground"
        onClick={() => column.toggleSorting()}
      >
        {label}
        <Icon data-icon="inline-end" className="text-muted-foreground" />
      </Button>
    </TableHead>
  )
}

// Pending-invite countdown shown under the name. Relative ("Går ut om 6 dagar")
// rather than a live ticker — it refreshes on refetch (realtime user.changed +
// resend invalidation), which is plenty for a 7-day window.
function InviteCountdown({ expiresAt }: { expiresAt: Date | null }) {
  if (!expiresAt) return null
  if (expiresAt.getTime() <= Date.now()) {
    return <span className="text-destructive text-xs">{m.user_invite_expired()}</span>
  }
  return (
    <span className="text-muted-foreground text-xs">
      {m.user_invite_expires({ time: formatDistanceShort(expiresAt) })}
    </span>
  )
}

function RoleLabel({ role }: { role: string | null }) {
  return role === 'admin' ? (
    <span className="inline-flex items-center gap-1 font-medium text-primary text-sm">
      <StarIcon className="size-3.5 fill-current" aria-hidden="true" />
      {m.user_role_admin()}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-muted-foreground text-sm">
      <SailboatIcon className="size-3.5" aria-hidden="true" />
      {m.user_role_sailor()}
    </span>
  )
}

function ShareBadge({ code }: { code: ShareCode }) {
  return (
    <Badge
      variant="outline"
      className={cn('border-transparent text-foreground', shareBackgroundClass[code])}
    >
      {code}
    </Badge>
  )
}
