import { keepPreviousData, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { renderToString } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import { renderWithProviders } from '~test/browser/render'
import { firstLoadPending, LoadErrorAlert, type LoadErrorQuery, loadFailed } from './LoadErrorAlert'

// The retry's queryFn call is synchronous but its re-render is not; let it land.
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

const failed = (over: Partial<LoadErrorQuery> = {}): LoadErrorQuery => ({
  data: undefined,
  isPlaceholderData: false,
  errorUpdateCount: 1,
  isFetching: false,
  refetch: () => {},
  ...over,
})

test('is a destructive alert whose retry refetches', async () => {
  const refetch = vi.fn()
  const { screen } = await renderWithProviders(
    <LoadErrorAlert title="Laddmönstren kunde inte hämtas" query={failed({ refetch })} />,
  )
  const alert = screen.getByRole('alert')
  await expect.element(alert).toHaveTextContent('Laddmönstren kunde inte hämtas')
  await expect.element(alert).toHaveTextContent('Kontrollera anslutningen och försök igen.')
  expect(alert.element().className).toMatch(/destructive/)
  await screen.getByRole('button', { name: 'Försök igen' }).click()
  expect(refetch).toHaveBeenCalledOnce()
})

test('the retry is disabled while the query refetches', async () => {
  const { screen } = await renderWithProviders(
    <LoadErrorAlert title="x" query={failed({ isFetching: true })} />,
  )
  await expect.element(screen.getByRole('button', { name: 'Försök igen' })).toBeDisabled()
})

test.each([
  ['a first load in flight', { errorUpdateCount: 0, isFetching: true }],
  ['data from an earlier success', { data: 'kept' }],
] as const)('renders nothing for %s', async (_, over) => {
  const { screen } = await renderWithProviders(<LoadErrorAlert title="x" query={failed(over)} />)
  expect(screen.getByRole('alert').elements()).toHaveLength(0)
})

// A real query, not a fake result: refetching a query that has no data resets
// it to `pending` with `error: null`, so the alert must survive that reset.
function Section({ queryFn }: { queryFn: () => Promise<string> }) {
  const query = useQuery({ queryKey: ['section'], queryFn })
  return query.data ? <p>{query.data}</p> : <LoadErrorAlert title="x" query={query} />
}

test('stays up, retry disabled, while a retry of a failed load is in flight', async () => {
  let resolveRetry: (value: string) => void = () => {}
  const queryFn = vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(new Error('down'))
    .mockImplementationOnce(() => new Promise((resolve) => (resolveRetry = resolve)))
  const { screen } = await renderWithProviders(<Section queryFn={queryFn} />)
  const retry = screen.getByRole('button', { name: 'Försök igen' })
  await retry.click()
  await expect.poll(() => queryFn.mock.calls.length).toBe(2)
  await settle()
  expect(screen.getByRole('alert').elements()).toHaveLength(1)
  await expect.element(retry).toBeDisabled()
  resolveRetry('loaded')
  await expect.element(screen.getByText('loaded')).toBeVisible()
  expect(screen.getByRole('alert').elements()).toHaveLength(0)
})

// The route's shape: keep the previous key's data while the next one loads.
function KeyedSection({ id, queryFn }: { id: string; queryFn: (id: string) => Promise<string> }) {
  const query = useQuery({
    queryKey: ['keyed', id],
    queryFn: () => queryFn(id),
    placeholderData: keepPreviousData,
  })
  return query.data && !loadFailed(query) ? (
    <p>{query.data}</p>
  ) : (
    <LoadErrorAlert title="x" query={query} />
  )
}

test('a retry after a failed key switch keeps the alert, not the previous key', async () => {
  let resolveRetry: (value: string) => void = () => {}
  const queryFn = vi
    .fn<(id: string) => Promise<string>>()
    .mockResolvedValueOnce('year A')
    .mockRejectedValueOnce(new Error('down'))
    .mockImplementationOnce(() => new Promise((resolve) => (resolveRetry = resolve)))
  const { screen, queryClient } = await renderWithProviders(
    <KeyedSection id="A" queryFn={queryFn} />,
  )
  await expect.element(screen.getByText('year A')).toBeVisible()
  await screen.rerender(
    <QueryClientProvider client={queryClient}>
      <KeyedSection id="B" queryFn={queryFn} />
    </QueryClientProvider>,
  )
  const retry = screen.getByRole('button', { name: 'Försök igen' })
  await retry.click()
  await expect.poll(() => queryFn.mock.calls.length).toBe(3)
  await settle()
  expect(screen.getByRole('alert').elements()).toHaveLength(1)
  expect(screen.getByText('year A').elements()).toHaveLength(0)
  resolveRetry('year B')
  await expect.element(screen.getByText('year B')).toBeVisible()
})

// A loader prefetch that failed on the server isn't dehydrated, so the client
// hydrates with no error; the server must render nothing too.
test('renders nothing on the server, so hydration matches the client', () => {
  expect(renderToString(<LoadErrorAlert title="x" query={failed({ isFetching: true })} />)).toBe('')
})

const pendingBase = {
  isPlaceholderData: false,
  errorUpdateCount: 0,
  isFetching: true,
  refetch: () => {},
}

test('firstLoadPending: nothing yet and nothing failed', () => {
  expect(firstLoadPending({ ...pendingBase, data: undefined })).toBe(true)
})
test('firstLoadPending: own data is not pending', () => {
  expect(firstLoadPending({ ...pendingBase, data: { x: 1 } })).toBe(false)
})
test("firstLoadPending: the previous key's placeholder keeps showing (dimmed), no skeleton", () => {
  expect(firstLoadPending({ ...pendingBase, data: { x: 1 }, isPlaceholderData: true })).toBe(false)
})
test('firstLoadPending: a failure shows the alert, not a skeleton', () => {
  expect(firstLoadPending({ ...pendingBase, data: undefined, errorUpdateCount: 1 })).toBe(false)
})
