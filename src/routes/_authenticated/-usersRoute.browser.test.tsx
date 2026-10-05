import { type QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { renderToString } from 'react-dom/server'
import { expect, test } from 'vitest'
import { render } from 'vitest-browser-react'
import { orpc } from '~/lib/orpc/client'
import type { UserListRow } from '~/lib/services/user'
import { m } from '~/paraglide/messages'
import { makeTestQueryClient } from '~test/browser/render'
import { Route as Users } from './users'

// The real page under a bare root (routeTree.gen.ts isn't loaded), with the cache
// seeded through the oRPC keys. Anything unseeded fails (no /api/rpc in the test
// server), which is how a failed read is staged. `-` keeps it out of the route tree.
const listKey = orpc.user.list.queryOptions().queryKey
const skeleton = (name: string) => document.querySelector(`[data-boneyard="${name}"]`)

const row = (over: Partial<UserListRow> = {}): UserListRow => ({
  status: 'active',
  id: 'u2',
  email: 'anna@example.com',
  name: 'Anna Andersson',
  phone: null,
  role: 'user',
  image: null,
  imageBlurhash: null,
  createdAt: new Date('2026-09-01T08:00:00Z'),
  ...over,
})

// A query whose fetch never settles stays `pending`.
const pendingForever = (qc: QueryClient) => {
  qc.removeQueries({ queryKey: listKey, exact: true })
  void qc.prefetchQuery({ queryKey: listKey, queryFn: () => new Promise(() => {}) })
}

async function loadUsers(
  search: string,
  prepare: (qc: QueryClient) => void,
  role: 'admin' | 'user' = 'admin',
) {
  const qc = makeTestQueryClient()
  qc.setDefaultOptions({ queries: { staleTime: Number.POSITIVE_INFINITY } })
  prepare(qc)
  const root = createRootRouteWithContext<{ queryClient: QueryClient; user: unknown }>()({
    component: Outlet,
  })
  ;(Users as unknown as { update: (o: unknown) => void }).update({
    id: '/users',
    path: '/users',
    getParentRoute: () => root,
  })
  const router = createRouter({
    routeTree: root.addChildren([Users as never]),
    context: { queryClient: qc, user: { id: 'u1', role } },
    history: createMemoryHistory({ initialEntries: [`/users${search}`] }),
  })
  await router.load()
  const ui = (
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  return { ui, router, qc }
}

async function renderUsers(
  search: string,
  prepare: (qc: QueryClient) => void,
  role: 'admin' | 'user' = 'admin',
) {
  const { ui, router, qc } = await loadUsers(search, prepare, role)
  const screen = await render(ui)
  return { screen, router, qc }
}

test('list still loading: the heading and invite button render, the table is a skeleton', async () => {
  const { screen } = await renderUsers('', pendingForever)
  await expect.element(screen.getByRole('heading', { name: m.users_title() })).toBeVisible()
  await expect.element(screen.getByRole('button', { name: m.users_invite_button() })).toBeVisible()
  await expect.poll(() => skeleton('users-table')).not.toBeNull()
  expect(screen.getByText(m.users_list_error_title()).elements()).toHaveLength(0)
})

test('list failed: the alert with a retry, no skeleton', async () => {
  const { screen } = await renderUsers('', () => {})
  await expect.element(screen.getByText(m.users_list_error_title())).toBeVisible()
  await expect.element(screen.getByRole('button', { name: m.common_try_again() })).toBeVisible()
  expect(skeleton('users-table')).toBeNull()
})

test('list cached: the table renders at once, no skeleton', async () => {
  const { screen } = await renderUsers('', (qc) => qc.setQueryData(listKey, [row()]))
  await expect.element(screen.getByText('Anna Andersson').first()).toBeVisible()
  expect(skeleton('users-table')).toBeNull()
})

test('a revoke deep link waits for the list, then opens', async () => {
  const { screen, router, qc } = await renderUsers(
    '?dialog=revoke&email=anna%40example.com',
    pendingForever,
  )
  await expect.poll(() => skeleton('users-table')).not.toBeNull()
  expect(screen.getByRole('alertdialog').elements()).toHaveLength(0)
  expect(router.state.location.search).toMatchObject({
    dialog: 'revoke',
    email: 'anna@example.com',
  })
  qc.setQueryData(listKey, [row()])
  await expect.element(screen.getByRole('alertdialog')).toBeVisible()
})

test('an edit deep link waits for the list, then opens', async () => {
  const { screen, router, qc } = await renderUsers('?dialog=edit&userId=u2', pendingForever)
  await expect.poll(() => skeleton('users-table')).not.toBeNull()
  expect(screen.getByRole('dialog').elements()).toHaveLength(0)
  expect(router.state.location.search).toMatchObject({ dialog: 'edit', userId: 'u2' })
  qc.setQueryData(listKey, [row()])
  await expect.element(screen.getByRole('dialog')).toBeVisible()
})

test('an edit deep link with a failed list shows the alert, not an error page', async () => {
  const { screen } = await renderUsers('?dialog=edit&userId=u2', () => {})
  await expect.element(screen.getByText(m.users_list_error_title())).toBeVisible()
  expect(screen.getByRole('dialog').elements()).toHaveLength(0)
})

test('a member sees the list without the invite button', async () => {
  const { screen } = await renderUsers('', (qc) => qc.setQueryData(listKey, [row()]), 'user')
  await expect.element(screen.getByText('Anna Andersson').first()).toBeVisible()
  expect(screen.getByRole('button', { name: m.users_invite_button() }).elements()).toHaveLength(0)
})

// A failed server prefetch isn't dehydrated, so the client hydrates with the list
// missing: both sides' pre-hydration HTML must match.
test('list failed on the server: the HTML matches the hydrating client', async () => {
  const server = await loadUsers('', (qc) =>
    qc
      .getQueryCache()
      .build(qc, { queryKey: listKey })
      .setState({
        status: 'error',
        error: new Error('x'),
        errorUpdateCount: 1,
        fetchStatus: 'idle',
      }),
  )
  const client = await loadUsers('', () => {})
  expect(renderToString(server.ui)).toBe(renderToString(client.ui))
})
