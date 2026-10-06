import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { UserPlusIcon } from 'lucide-react'
import { lazy } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import usersTableBones from '~/bones/users-table.bones.json'
import { LazyDialogMount } from '~/components/layout/LazyDialogMount'
import { firstLoadPending, LoadErrorAlert, loadFailed } from '~/components/layout/LoadErrorAlert'
import { PageContainer } from '~/components/layout/PageContainer'
import { SectionSkeleton } from '~/components/layout/SectionSkeleton'
import { Button } from '~/components/ui/button'
import { type RevokeTarget, RevokeUserDialog } from '~/components/user/RevokeUserDialog'
import { UsersTable } from '~/components/user/UsersTable'
import { useIdlePreload } from '~/hooks/useIdlePreload'
import { useUrlDialog } from '~/hooks/useUrlDialog'
import { orpc } from '~/lib/orpc/client'
import { loadRouteData } from '~/lib/query/routeData'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

const usersSearchSchema = z.object({
  dialog: z.enum(['invite', 'edit', 'revoke']).optional(),
  userId: z.string().optional(),
  email: z.string().optional(),
})

// Admin-only: loads on first open (LazyDialogMount), so a member never fetches the form code;
// an admin warms the chunks once the browser is idle (useIdlePreload).
const loadInviteUserDialog = () => import('~/components/user/InviteUserDialog')
const loadEditUserDialog = () => import('~/components/user/EditUserDialog')
const InviteUserDialog = lazy(() =>
  loadInviteUserDialog().then((mod) => ({ default: mod.InviteUserDialog })),
)
const EditUserDialog = lazy(() =>
  loadEditUserDialog().then((mod) => ({ default: mod.EditUserDialog })),
)
const ADMIN_DIALOG_LOADERS = [loadInviteUserDialog, loadEditUserDialog]

type UsersSearch = z.infer<typeof usersSearchSchema>
type UsersDialog = NonNullable<UsersSearch['dialog']>

export const Route = createFileRoute('/_authenticated/users')({
  head: () => ({
    meta: seo({
      title: m.meta_users_title(),
      description: m.meta_users_description(),
    }),
  }),
  validateSearch: usersSearchSchema,
  // No loaderDeps: a dialog's search params aren't the loader's input.
  loader: ({ context: { queryClient } }) =>
    loadRouteData(queryClient, { critical: [orpc.user.list.queryOptions()] }),
  component: Users,
})

function Users() {
  const { user: currentUser } = Route.useRouteContext()
  const isAdmin = currentUser.role === 'admin'
  useIdlePreload(isAdmin, ADMIN_DIALOG_LOADERS)
  const queryClient = useQueryClient()

  const navigate = Route.useNavigate()
  const dialog = Route.useSearch({ select: (s) => s.dialog })
  const userId = Route.useSearch({ select: (s) => s.userId })
  const email = Route.useSearch({ select: (s) => s.email })
  const { isOpen, open, close } = useUrlDialog<UsersDialog, UsersSearch>({
    current: dialog,
    navigate,
    clearKeys: ['userId', 'email'],
  })

  const isInvite = isAdmin && isOpen('invite')
  const isEdit = isAdmin && isOpen('edit')
  const isRevoke = isAdmin && isOpen('revoke')

  const revokeEmail = isRevoke ? email : undefined

  // The directory is the one screen where another admin's invite/edit/revoke
  // should surface without a manual reload. Polling — not a push — because an
  // open SSE stream keeps a Vercel Fluid instance (and its 2 GB of provisioned
  // memory) billing 24/7; see ADR-0018. Same cadence as the sensors tiles.
  const usersResult = useQuery({
    ...orpc.user.list.queryOptions(),
    refetchInterval: 60_000,
  })
  const users = loadFailed(usersResult) ? undefined : usersResult.data
  // Both row dialogs wait for the list (like revoke's target below): the edit
  // form reads the list through suspense, which would throw a failed read to the
  // route error boundary instead of the alert.
  const editUserId = isEdit && users ? userId : undefined
  const editUserOpen = isEdit && editUserId !== undefined
  const revokeUserRow = revokeEmail ? users?.find((u) => u.email === revokeEmail) : undefined
  const revokeTarget: RevokeTarget | undefined = revokeUserRow
    ? { email: revokeUserRow.email, name: revokeUserRow.name, status: revokeUserRow.status }
    : undefined

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
    <PageContainer width="full" fill>
      <header className="flex flex-col gap-2">
        <h1 className="font-bold text-2xl tracking-tight text-balance md:text-3xl">
          {m.users_title()}
        </h1>
        <p className="max-w-2xl text-muted-foreground text-sm">{m.users_description()}</p>
      </header>

      {isAdmin ? (
        <div className="flex justify-end">
          <Button onClick={() => open('invite')}>
            <UserPlusIcon />
            {m.users_invite_button()}
          </Button>
        </div>
      ) : null}

      <LoadErrorAlert title={m.users_list_error_title()} query={usersResult} />
      {/* The table bleeds md:-mx-4 past the content column, so its cell padding
          lines up with the heading. The bleed sits outside the skeleton, so the
          bones are captured, and replayed, at the table's full width. */}
      <div className="flex min-h-0 w-full flex-col md:-mx-4">
        <SectionSkeleton
          bones={usersTableBones}
          loading={firstLoadPending(usersResult)}
          fallbackHeight="20rem"
          excludeSelectors={['[data-no-skeleton]']}
        >
          {users ? (
            <UsersTable
              users={users}
              currentUserId={currentUser.id}
              isAdmin={isAdmin}
              onEdit={(id) => open('edit', { userId: id })}
              onRevoke={(targetEmail) => open('revoke', { email: targetEmail })}
              onResendInvite={
                isAdmin
                  ? (targetEmail) => {
                      if (!resendInvite.isPending) resendInvite.mutate({ email: targetEmail })
                    }
                  : undefined
              }
            />
          ) : null}
        </SectionSkeleton>
      </div>

      {isAdmin ? (
        <>
          <LazyDialogMount open={isInvite}>
            <InviteUserDialog
              open={isInvite}
              onOpenChange={(open) => {
                if (!open) close()
              }}
            />
          </LazyDialogMount>
          <LazyDialogMount open={editUserOpen}>
            <EditUserDialog
              open={editUserOpen}
              userId={editUserId}
              onOpenChange={(open) => {
                if (!open) close()
              }}
            />
          </LazyDialogMount>
          <RevokeUserDialog
            open={isRevoke && revokeTarget !== undefined}
            target={revokeTarget}
            onOpenChange={(open) => {
              if (!open) close()
            }}
          />
        </>
      ) : null}
    </PageContainer>
  )
}
