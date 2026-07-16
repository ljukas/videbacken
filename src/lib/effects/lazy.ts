/**
 * Resolve an async `factory` once, then reuse the cached promise. Used by the
 * multi-adapter effects (email/storage/queue) to select + dynamically import
 * their adapter on first use and reuse it thereafter — the adapter stays
 * code-split (the factory's `await import()` is preserved) and the selection
 * runs exactly once per process.
 *
 * The factory must be non-throwing / side-effect-free: a rejected promise is
 * cached like any other (acceptable here — selection is pure env branching +
 * a static first-party import that can't fail transiently).
 */
export function lazy<T>(factory: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | null = null
  return () => (cached ??= factory())
}
