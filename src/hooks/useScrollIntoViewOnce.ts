import { useEffect, useRef } from 'react'

/**
 * Returns a ref that scrolls its element into view (centered) when `active`
 * becomes true — used to bring the command-palette focus target (`?focus=<id>`)
 * into view. Defers a frame so the row/card is laid out (the documents view swaps
 * in from a skeleton on mount). Honours Reduce Motion by skipping smooth scroll.
 */
export function useScrollIntoViewOnce<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T>(null)
  useEffect(() => {
    if (!active) return
    const id = requestAnimationFrame(() => {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ref.current?.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
    })
    return () => cancelAnimationFrame(id)
  }, [active])
  return ref
}
