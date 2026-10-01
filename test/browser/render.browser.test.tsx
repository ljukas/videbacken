import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { expect, test } from 'vitest'
import { makeTestQueryClient, renderWithProviders, renderWithRouter } from './render'

// staleTime:Infinity means a seeded value is served without the queryFn ever
// running — so this test never depends on a (nonexistent) server.
function Probe() {
  const { data } = useQuery({
    queryKey: ['probe'],
    queryFn: async () => 'fetched-from-server',
    staleTime: Number.POSITIVE_INFINITY,
  })
  return <p>{data ?? 'loading'}</p>
}

test('renderWithProviders renders data seeded into the QueryClient cache', async () => {
  const queryClient = makeTestQueryClient()
  queryClient.setQueryData(['probe'], 'seeded-value')

  const { screen } = await renderWithProviders(<Probe />, { queryClient })

  await expect.element(screen.getByText('seeded-value')).toBeVisible()
})

test('renderWithRouter gives <Link> a router to build hrefs from', async () => {
  const { screen } = await renderWithRouter(<Link to="/charging/economy">x</Link>)

  await expect
    .element(screen.getByRole('link', { name: 'x' }))
    .toHaveAttribute('href', '/charging/economy')
})
