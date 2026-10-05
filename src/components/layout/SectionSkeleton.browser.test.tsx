import { expect, test } from 'vitest'
import { renderWithRouter } from '~test/browser/render'
import { SectionSkeleton } from './SectionSkeleton'

test('not loading: the children, with no wrapper around them', async () => {
  const { screen } = await renderWithRouter(
    <div data-testid="parent">
      <SectionSkeleton name="t" loading={false}>
        <p>content</p>
      </SectionSkeleton>
    </div>,
  )
  await expect.element(screen.getByText('content')).toBeVisible()
  const parent = screen.getByTestId('parent').element()
  expect(parent.firstElementChild?.tagName).toBe('P')
})

test('loading, no captured bones: a busy fallback block instead of the children', async () => {
  const { screen } = await renderWithRouter(
    <SectionSkeleton name="never-captured" loading>
      <p>content</p>
    </SectionSkeleton>,
  )
  // renderWithRouter resolves before the router has rendered the route, so wait
  // for the skeleton itself before asserting what is absent.
  await expect
    .poll(() =>
      document.querySelector('[data-boneyard="never-captured"]')?.getAttribute('aria-busy'),
    )
    .toBe('true')
  await expect.element(screen.getByText('content')).not.toBeInTheDocument()
  expect(document.querySelector('[data-section-skeleton-fallback]')).not.toBeNull()
})
