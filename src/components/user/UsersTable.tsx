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
  MoreVerticalIcon,
  PencilIcon,
  SendIcon,
  ShieldIcon,
  Trash2Icon,
  UserIcon,
} from 'lucide-react'
import { formatPhoneNumberIntl } from 'react-phone-number-input'
import { Avatar, AvatarFallback, AvatarImage } from '~/components/ui/avatar'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import { RowActions } from '~/components/ui/row-actions'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import type { UserListRow } from '~/lib/services/user'
import { cn, initials } from '~/lib/utils'
import { m } from '~/paraglide/messages'

type Props = {
  users: Array<UserListRow>
  currentUserId: string
  isAdmin: boolean
  onEdit: (id: string) => void
  onRevoke: (email: string) => void
  /** Resend the invite email to a pending user (admin only). */
  onResendInvite?: (email: string) => void
}

// Secondary columns reveal as the viewport widens: Roll + Status at `md`,
// E-post + Telefon at `lg`. Whatever isn't yet a column folds in as a muted
// sub-line under the name, so nothing is lost on narrow screens.
const ROLE_CELL = 'hidden md:table-cell'
const STATUS_CELL = 'hidden md:table-cell'
const EMAIL_CELL = 'hidden lg:table-cell'
const PHONE_CELL = 'hidden lg:table-cell'

function roleLabel(role: string): string {
  return role === 'admin' ? m.user_role_admin() : m.user_role_user()
}

function statusLabel(status: UserListRow['status']): string {
  return status === 'pending' ? m.user_status_pending() : m.user_status_active()
}

// Only the sortable data columns live in the table model (it drives sort state
// and the sorted row order); cells are hand-rendered per row below.
const columns: Array<ColumnDef<UserListRow>> = [
  {
    id: 'name',
    accessorFn: (u) => u.name || u.email,
    header: () => m.user_field_name(),
    sortingFn: 'text',
  },
  {
    id: 'role',
    accessorFn: (u) => roleLabel(u.role),
    header: () => m.user_field_role(),
    sortingFn: 'text',
  },
  {
    id: 'status',
    accessorFn: (u) => statusLabel(u.status),
    header: () => m.user_field_status(),
    sortingFn: 'text',
  },
]

export function UsersTable({
  users,
  currentUserId,
  isAdmin,
  onEdit,
  onRevoke,
  onResendInvite,
}: Props) {
  const table = useReactTable({
    data: users,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    // No initial sorting — the server returns active users first, then
    // pending invites (see listUsersAndPending); columns become sortable on
    // click (a toggled sort takes over, so the grouping only holds by default).
  })
  const rows = table.getRowModel().rows

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
          <SortableHead
            column={table.getColumn('status')}
            label={m.user_field_status()}
            className={STATUS_CELL}
          />
          <TableHead className={EMAIL_CELL}>{m.user_field_email()}</TableHead>
          <TableHead className={PHONE_CELL}>{m.user_field_phone()}</TableHead>
          {isAdmin ? (
            <TableHead className="w-10">
              <span className="sr-only">{m.common_actions()}</span>
            </TableHead>
          ) : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <UserTableRow
            key={row.original.id}
            row={row.original}
            isSelf={row.original.status === 'active' && row.original.id === currentUserId}
            isAdmin={isAdmin}
            onEdit={onEdit}
            onRevoke={onRevoke}
            onResendInvite={onResendInvite}
          />
        ))}
      </TableBody>
    </Table>
  )
}

function UserTableRow({
  row,
  isSelf,
  isAdmin,
  onEdit,
  onRevoke,
  onResendInvite,
}: {
  row: UserListRow
  isSelf: boolean
  isAdmin: boolean
  onEdit: (id: string) => void
  onRevoke: (email: string) => void
  onResendInvite?: (email: string) => void
}) {
  const formattedPhone = row.phone ? formatPhoneNumberIntl(row.phone) || row.phone : null
  const displayName = row.name || row.email
  const isPending = row.status === 'pending'

  return (
    <TableRow className="group/row">
      <TableCell>
        <div className="flex min-w-0 items-center gap-3">
          <Avatar className="size-9 shrink-0">
            {row.image ? (
              <AvatarImage
                src={row.image}
                alt={displayName}
                width={36}
                height={36}
                blurhash={row.imageBlurhash}
              />
            ) : null}
            <AvatarFallback>{initials(displayName)}</AvatarFallback>
          </Avatar>

          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate font-medium" title={displayName}>
                {displayName}
              </span>
              {isSelf ? <Badge variant="secondary">{m.users_badge_you()}</Badge> : null}
              {isPending ? (
                <Badge variant="outline" className="border-brand/30 bg-brand/10 text-brand">
                  {m.user_status_pending()}
                </Badge>
              ) : null}
            </div>

            {/* Roll folds in here until it becomes a column at `md`. */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 md:hidden">
              <RoleLabel role={row.role} />
            </div>

            {/* E-post + Telefon fold in here until they become columns at `lg`. */}
            <div className="flex flex-col gap-0.5 text-xs lg:hidden">
              <a
                href={`mailto:${row.email}`}
                className="truncate text-muted-foreground transition-colors hover:text-foreground"
                title={row.email}
              >
                {row.email}
              </a>
              {formattedPhone ? (
                <a
                  href={`tel:${row.phone}`}
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
        <RoleLabel role={row.role} />
      </TableCell>

      <TableCell className={STATUS_CELL}>
        {isPending ? (
          <Badge variant="outline" className="border-brand/30 bg-brand/10 text-brand">
            {m.user_status_pending()}
          </Badge>
        ) : (
          <span className="text-muted-foreground text-sm">{m.user_status_active()}</span>
        )}
      </TableCell>

      <TableCell className={EMAIL_CELL}>
        <a
          href={`mailto:${row.email}`}
          className="text-muted-foreground transition-colors hover:text-foreground"
          title={row.email}
        >
          {row.email}
        </a>
      </TableCell>

      <TableCell className={cn(PHONE_CELL, 'text-muted-foreground tabular-nums')}>
        {formattedPhone ? (
          <a href={`tel:${row.phone}`} className="transition-colors hover:text-foreground">
            {formattedPhone}
          </a>
        ) : (
          '—'
        )}
      </TableCell>

      {isAdmin ? (
        <TableCell className="text-right">
          <RowActions>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={m.users_actions_for({ name: displayName })}
                >
                  <MoreVerticalIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {isPending ? (
                  onResendInvite ? (
                    <DropdownMenuItem onSelect={() => onResendInvite(row.email)}>
                      <SendIcon />
                      {m.user_resend_invite()}
                    </DropdownMenuItem>
                  ) : null
                ) : (
                  <DropdownMenuItem onSelect={() => onEdit(row.id)}>
                    <PencilIcon />
                    {m.common_edit()}
                  </DropdownMenuItem>
                )}
                {isSelf ? null : (
                  <DropdownMenuItem variant="destructive" onSelect={() => onRevoke(row.email)}>
                    <Trash2Icon />
                    {m.user_revoke_action()}
                  </DropdownMenuItem>
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
  column: Column<UserListRow> | undefined
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

function RoleLabel({ role }: { role: string }) {
  return role === 'admin' ? (
    <span className="inline-flex items-center gap-1 font-medium text-primary text-sm">
      <ShieldIcon className="size-3.5 fill-current" aria-hidden="true" />
      {m.user_role_admin()}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-muted-foreground text-sm">
      <UserIcon className="size-3.5" aria-hidden="true" />
      {m.user_role_user()}
    </span>
  )
}
