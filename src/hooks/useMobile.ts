import * as React from 'react'

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener('change', onChange)
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return !!isMobile
}

/**
 * True on touch-primary devices (phones, tablets) where the pointer is coarse.
 * Unlike {@link useIsMobile}, this keys off pointer type rather than viewport
 * width, so a wide tablet still reads as touch and a touchscreen laptop with a
 * mouse does not. Starts `false` during SSR/first paint, then resolves after
 * hydration.
 */
export function useIsCoarsePointer() {
  const [coarse, setCoarse] = React.useState(false)

  React.useEffect(() => {
    const mql = window.matchMedia('(pointer: coarse)')
    const onChange = () => setCoarse(mql.matches)
    mql.addEventListener('change', onChange)
    setCoarse(mql.matches)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return coarse
}
