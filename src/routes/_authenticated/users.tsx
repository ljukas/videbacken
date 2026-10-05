import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { UserPlusIcon } from 'lucide-react'
import { toast } from 'sonner'
import { z } from 'zod'
import { firstLoadPending, LoadErrorAlert, loadFailed } from '~/components/layout/LoadErrorAlert'
import { PageContainer } from '~/components/layout/PageContainer'
import { SectionSkeleton } from '~/components/layout/SectionSkeleton'
import { Button } from '~/components/ui/button'
import { EditUserDialog } from '~/components/user/EditUserDialog'
import { InviteUserDialog } from '~/components/user/InviteUserDialog'
import { type RevokeTarget, RevokeUserDialog } from '~/components/user/RevokeUserDialog'
import { UsersTable } from '~/components/user/UsersTable'
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
  // No loaderDeps: opening a dialog (a search change) mustn't re-run the loader.
  loader: ({ context: { queryClient } }) =>
    loadRouteData(queryClient, { critical: [orpc.user.list.queryOptions()] }),
  component: Users,
})

function Users() {
  const { user: currentUser } = Route.useRouteContext()
  const isAdmin = currentUser.role === 'admin'
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
      <SectionSkeleton
        name="users-table"
        loading={firstLoadPending(usersResult)}
        fallbackHeight="20rem"
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
