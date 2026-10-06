import { registerBones } from 'boneyard-js'
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

test('loading announces a status; not loading has none', async () => {
  const loading = await renderWithRouter(
    <SectionSkeleton name="status-a" loading>
      <p>content</p>
    </SectionSkeleton>,
  )
  await expect.element(loading.screen.getByRole('status')).toMatchTextContent('Laddar')
  await loading.screen.unmount()
  const idle = await renderWithRouter(
    <SectionSkeleton name="status-b" loading={false}>
      <p>content</p>
    </SectionSkeleton>,
  )
  await expect.element(idle.screen.getByText('content')).toBeVisible()
  expect(document.querySelector('[role="status"]')).toBeNull()
})

// A tiny capture: 237 px tall, two bars. Not keyed by breakpoint, so any width uses it.
registerBones({
  'test-sized': {
    name: 'test-sized',
    viewportWidth: 300,
    width: 300,
    height: 237,
    bones: [
      [0, 0, 100, 20, 4],
      [0, 40, 50, 20, 4],
    ],
  },
})

test('loading with captured bones: no children, and the wrapper reserves the captured height', async () => {
  const { screen } = await renderWithRouter(
    <div style={{ width: 300 }}>
      <SectionSkeleton name="test-sized" loading fallbackHeight="5rem">
        {/* A no-data render shorter than the capture: it must not set the bones' scale. */}
        <p style={{ height: 30 }}>content</p>
      </SectionSkeleton>
    </div>,
  )
  const wrapper = () => document.querySelector<HTMLElement>('[data-boneyard="test-sized"]')
  await expect.poll(() => wrapper()?.querySelectorAll('[data-boneyard-bone]').length).toBe(2)
  expect(screen.getByText('content').elements()).toHaveLength(0)
  // boneyard sets the reserved height inline (minHeight) and scales the bones to the
  // measured height: both must be the capture's, not the fallback's (80 px) or the children's.
  await expect.poll(() => wrapper()?.getBoundingClientRect().height).toBe(237)
  expect(wrapper()?.style.minHeight).toBe('237px')
  const second = wrapper()?.querySelectorAll<HTMLElement>('[data-boneyard-bone]')[1]
  expect(second?.style.top).toBe('40px') // scaleY 1
})
