import { expect, test } from 'vitest'
import { renderWithProviders } from '~test/browser/render'
import { PageContainer } from './PageContainer'

// Browser tests don't load app.css, so this pins the classes; the real scroll
// is checked live on a phone.

// iOS Safari only shrinks its toolbars, and only draws the page under the
// bottom bar, when the document scrolls. A scroll box on a phone keeps the
// toolbar big and pulls the whole page when a swipe reaches its edge.
test.each([
  ['default', {}],
  ['fill', { fill: true }],
  ['fill lg', { fill: 'lg' as const }],
])('%s: below md the page scrolls the document, not its own box', async (_, props) => {
  const { screen } = await renderWithProviders(
    <PageContainer {...props}>
      <p>Innehåll</p>
    </PageContainer>,
  )
  const container = screen.getByText('Innehåll').element().closest('[data-slot="page-container"]')
  const unprefixedOverflow = container?.className
    .split(/\s+/)
    .filter((c) => c.startsWith('overflow-'))
  expect(unprefixedOverflow).toEqual([])
})
