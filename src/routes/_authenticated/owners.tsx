import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { UserPlusIcon } from 'lucide-react'
import { toast } from 'sonner'
import { z } from 'zod'
import { PageContainer } from '~/components/layout/PageContainer'
import { Button } from '~/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'
import { DeleteUserDialog } from '~/components/user/DeleteUserDialog'
import { EditUserDialog } from '~/components/user/EditUserDialog'
import { InviteUserDialog } from '~/components/user/InviteUserDialog'
import { type OwnerRow, OwnersTable } from '~/components/user/OwnersTable'
import { RestoreUserDialog } from '~/components/user/RestoreUserDialog'
import { useUrlDialog } from '~/hooks/useUrlDialog'
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

const ownersSearchSchema = z.object({
  filter: z.enum(['active', 'deleted']).optional(),
  dialog: z.enum(['invite', 'edit', 'delete', 'restore']).optional(),
  userId: z.string().optional(),
})

type OwnersSearch = z.infer<typeof ownersSearchSchema>
type OwnersDialog = NonNullable<OwnersSearch['dialog']>

export const Route = createFileRoute('/_authenticated/owners')({
  head: () => ({
    meta: seo({
      title: m.meta_owners_title(),
      description: m.meta_owners_description(),
    }),
  }),
  validateSearch: ownersSearchSchema,
  loaderDeps: ({ search }) => ({
    filter: search.filter ?? 'active',
    dialog: search.dialog,
    userId: search.userId,
  }),
  loader: async ({ context: { queryClient, user }, deps }) => {
    const isAdmin = user.role === 'admin'
    const showDeleted = isAdmin && deps.filter === 'deleted'
    await Promise.all([
      queryClient.ensureQueryData(orpc.presence.listOnline.queryOptions()),
      showDeleted
        ? queryClient.ensureQueryData(orpc.user.list.queryOptions({ input: { filter: 'deleted' } }))
        : queryClient.ensureQueryData(orpc.user.listContacts.queryOptions()),
      ...(isAdmin && (deps.dialog === 'edit' || deps.dialog === 'delete') && deps.userId
        ? [
            queryClient.ensureQueryData(
              orpc.user.getById.queryOptions({ input: { id: deps.userId } }),
            ),
          ]
        : []),
    ])
  },
  component: Owners,
})

function Owners() {
  const { user: currentUser } = Route.useRouteContext()
  const isAdmin = currentUser.role === 'admin'
  const filter = Route.useSearch({ select: (s) => s.filter ?? 'active' })
  const showDeleted = isAdmin && filter === 'deleted'

  const navigate = Route.useNavigate()
  const userId = Route.useSearch({ select: (s) => s.userId })
  const dialog = Route.useSearch({ select: (s) => s.dialog })
  const { isOpen, open, close } = useUrlDialog<OwnersDialog, OwnersSearch>({
    current: dialog,
    navigate,
    clearKeys: ['userId'],
  })

  const isInvite = isAdmin && isOpen('invite')
  const isEdit = isAdmin && isOpen('edit')
  const isDelete = isAdmin && isOpen('delete')
  const isRestore = isAdmin && isOpen('restore')

  const editUserId = isEdit ? userId : undefined
  const deleteUserId = isDelete ? userId : undefined
  const restoreUserId = isRestore ? userId : undefined

  // Restore only happens from the deleted view, whose list is already cached by
  // the loader — read the name from cache for a friendlier confirmation message.
  const { data: deletedUsers } = useQuery({
    ...orpc.user.list.queryOptions({ input: { filter: 'deleted' } }),
    enabled: showDeleted,
  })
  const restoreUserName = restoreUserId
    ? deletedUsers?.find((u) => u.id === restoreUserId)?.name
    : undefined

  const onEdit = (id: string) => open('edit', { userId: id })
  const onDelete = (id: string) => open('delete', { userId: id })
  const onRestore = (id: string) => open('restore', { userId: id, filter: 'deleted' })

  return (
    <PageContainer width="full" fill>
      <header className="flex flex-col gap-2">
        <h1 className="font-bold text-2xl tracking-tight text-balance md:text-3xl">
          {m.owners_title()}
        </h1>
        <p className="max-w-2xl text-muted-foreground text-sm">{m.owners_description()}</p>
      </header>

      {isAdmin ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {showDeleted ? (
            <div />
          ) : (
            <Button onClick={() => open('invite')}>
              <UserPlusIcon />
              {m.owners_invite_button()}
            </Button>
          )}

          <ToggleGroup
            type="single"
            value={filter}
            variant="outline"
            onValueChange={(next) => {
              if (!next || next === filter) return
              navigate({ to: '.', search: { filter: next as 'active' | 'deleted' } })
            }}
            aria-label={m.owners_filter_label()}
          >
            <ToggleGroupItem value="active">{m.owners_filter_active()}</ToggleGroupItem>
            <ToggleGroupItem value="deleted">{m.owners_filter_deleted()}</ToggleGroupItem>
          </ToggleGroup>
        </div>
      ) : null}

      {showDeleted ? (
        <DeletedOwners
          currentUserId={currentUser.id}
          onRestore={onRestore}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ) : (
        <ActiveOwners
          currentUserId={currentUser.id}
          isAdmin={isAdmin}
          onEdit={onEdit}
          onDelete={onDelete}
          onRestore={onRestore}
        />
      )}

      {isAdmin ? (
        <>
          <InviteUserDialog
            open={isInvite}
            onOpenChange={(open) => {
              if (!open) close()
            }}
          />
          <EditUserDialog
            open={isEdit && editUserId !== undefined}
            userId={editUserId}
            onOpenChange={(open) => {
              if (!open) close()
            }}
          />
          <DeleteUserDialog
            open={isDelete && deleteUserId !== undefined}
            userId={deleteUserId}
            onOpenChange={(open) => {
              if (!open) close()
            }}
          />
          <RestoreUserDialog
            open={isRestore && restoreUserId !== undefined}
            userId={restoreUserId}
            userName={restoreUserName}
            onOpenChange={(open) => {
              if (!open) close()
            }}
          />
        </>
      ) : null}
    </PageContainer>
  )
}

function ActiveOwners({
  currentUserId,
  isAdmin,
  onEdit,
  onDelete,
  onRestore,
}: {
  currentUserId: string
  isAdmin: boolean
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onRestore: (id: string) => void
}) {
  const { data: owners } = useSuspenseQuery(orpc.user.listContacts.queryOptions())
  const { data: onlineIds } = useSuspenseQuery(orpc.presence.listOnline.queryOptions())
  const queryClient = useQueryClient()
  const resendInvite = useMutation(
    orpc.user.resendInvite.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.user.key() })
        toast.success(m.user_resend_invite_success())
      },
      onError: () => toast.error(m.user_resend_invite_error()),
    }),
  )
  return (
    <OwnersTable
      owners={owners}
      onlineSet={new Set(onlineIds)}
      currentUserId={currentUserId}
      isAdmin={isAdmin}
      showDeleted={false}
      onEdit={onEdit}
      onDelete={onDelete}
      onRestore={onRestore}
      onResendInvite={
        // Ignore a second click while a resend is already in flight, so a
        // double-select doesn't fire two sends (and a spurious error toast).
        isAdmin ? (id) => !resendInvite.isPending && resendInvite.mutate({ id }) : undefined
      }
    />
  )
}

function DeletedOwners({
  currentUserId,
  onEdit,
  onDelete,
  onRestore,
}: {
  currentUserId: string
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onRestore: (id: string) => void
}) {
  const { data: users } = useSuspenseQuery(
    orpc.user.list.queryOptions({ input: { filter: 'deleted' } }),
  )
  const { data: onlineIds } = useSuspenseQuery(orpc.presence.listOnline.queryOptions())
  // Deleted users carry no current share ownership; normalize to the table's row shape.
  const owners: Array<OwnerRow> = users.map((u) => ({ ...u, shares: [] }))
  return (
    <OwnersTable
      owners={owners}
      onlineSet={new Set(onlineIds)}
      currentUserId={currentUserId}
      isAdmin
      showDeleted
      onEdit={onEdit}
      onDelete={onDelete}
      onRestore={onRestore}
    />
  )
}
