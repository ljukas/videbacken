import { useCallback, useRef } from 'react'

// The top of a paged list, for after a page change. Paging from the control
// under a long page would leave the new page's newest rows above the fold, so
// `reveal` scrolls the list's heading back into view — but only when it is out
// of view above, and then moves focus to it (the heading needs tabIndex={-1}).
// Scrolling without moving focus would leave a keyboard user's focus on a
// control that's now off-screen. With the heading still in view nothing
// moves, so clicking "next" again stays under the pointer.
export function useListTop<T extends HTMLElement = HTMLHeadingElement>() {
  const ref = useRef<T>(null)
  const reveal = useCallback(() => {
    const heading = ref.current
    if (!heading) return
    if (heading.getBoundingClientRect().top >= scrollerTop(heading)) return
    heading.scrollIntoView({ block: 'start' })
    heading.focus({ preventScroll: true })
  }, [])
  return { ref, reveal }
}

// The top edge of the element's nearest scrolling ancestor (PageContainer's
// scroller in the app), or the viewport's.
function scrollerTop(el: HTMLElement): number {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node.getBoundingClientRect().top
    }
  }
  return 0
}
