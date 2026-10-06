import { useCallback, useSyncExternalStore } from 'react'

// A per-browser boolean preference (a viewer convenience, never shared state). The server and the first client
// render use `fallback`, so hydration agrees; a stored value applies right after. Without storage (a private
// window, blocked site data) the value lives in memory for the session.
const memory = new Map<string, boolean>()
const CHANGE = 'videbacken:local-flag'

function read(key: string, fallback: boolean): boolean {
  // Memory only holds a value whose write to storage failed, so it is the newer one and wins.
  const remembered = memory.get(key)
  if (remembered !== undefined) return remembered
  try {
    const v = window.localStorage.getItem(key)
    if (v !== null) return v === '1'
  } catch {}
  return fallback
}

export function useLocalStorageFlag(key: string, fallback: boolean) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const onStorage = (e: StorageEvent) => {
        if (e.key === null || e.key === key) onChange()
      }
      window.addEventListener('storage', onStorage)
      window.addEventListener(CHANGE, onChange)
      return () => {
        window.removeEventListener('storage', onStorage)
        window.removeEventListener(CHANGE, onChange)
      }
    },
    [key],
  )
  const value = useSyncExternalStore(
    subscribe,
    () => read(key, fallback),
    () => fallback,
  )
  const set = useCallback(
    (next: boolean) => {
      try {
        window.localStorage.setItem(key, next ? '1' : '0')
        memory.delete(key)
      } catch {
        // Storage is unavailable: keep the choice for this session only.
        memory.set(key, next)
      }
      window.dispatchEvent(new Event(CHANGE))
    },
    [key],
  )
  return [value, set] as const
}
