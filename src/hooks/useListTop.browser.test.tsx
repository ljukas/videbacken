import { expect, test } from 'vitest'
import { render } from 'vitest-browser-react'
import { useListTop } from './useListTop'

// A scroller like PageContainer's: a heading, a long list, and a control under it.
function Harness() {
  const { ref, reveal } = useListTop()
  return (
    <div data-testid="scroller" style={{ height: 300, overflowY: 'auto' }}>
      <h2 ref={ref} tabIndex={-1}>
        Sessions
      </h2>
      <div style={{ height: 1_000 }} />
      <button type="button" onClick={reveal}>
        Next
      </button>
    </div>
  )
}

test('paging from a control below the fold brings the heading back and focuses it', async () => {
  const screen = await render(<Harness />)
  const scroller = screen.getByTestId('scroller').element() as HTMLElement
  const next = screen.getByRole('button', { name: 'Next' })
  scroller.scrollTop = scroller.scrollHeight
  ;(next.element() as HTMLButtonElement).focus()
  ;(next.element() as HTMLButtonElement).click()
  const heading = screen.getByRole('heading', { name: 'Sessions' }).element() as HTMLElement
  // The focused element stays visible: focus moves with the scroll, not left below the fold.
  expect(document.activeElement).toBe(heading)
  expect(heading.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    scroller.getBoundingClientRect().top - 1,
  )
})

test('with the heading already in view, nothing scrolls and focus stays on the control', async () => {
  const screen = await render(
    <div style={{ height: 2_000 }}>
      <SmallHarness />
    </div>,
  )
  const next = screen.getByRole('button', { name: 'Next' })
  ;(next.element() as HTMLButtonElement).focus()
  ;(next.element() as HTMLButtonElement).click()
  expect(document.activeElement).toBe(next.element())
})

function SmallHarness() {
  const { ref, reveal } = useListTop()
  return (
    <div>
      <h2 ref={ref} tabIndex={-1}>
        Sessions
      </h2>
      <button type="button" onClick={reveal}>
        Next
      </button>
    </div>
  )
}

test('a heading hidden under a scroller that sits below a header still counts as out of view', async () => {
  // The heading's viewport top stays positive (the header pushes the scroller
  // down), but it has scrolled above the scroller's top edge.
  const screen = await render(
    <div>
      <div style={{ height: 120 }} />
      <Harness />
    </div>,
  )
  const scroller = screen.getByTestId('scroller').element() as HTMLElement
  scroller.scrollTop = 60
  const heading = screen.getByRole('heading', { name: 'Sessions' }).element() as HTMLElement
  expect(heading.getBoundingClientRect().top).toBeGreaterThan(0)
  expect(heading.getBoundingClientRect().top).toBeLessThan(scroller.getBoundingClientRect().top)
  ;(screen.getByRole('button', { name: 'Next' }).element() as HTMLButtonElement).click()
  expect(document.activeElement).toBe(heading)
})
