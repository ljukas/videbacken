import Bowser from 'bowser'

/**
 * True when `userAgent` is an iPhone/iPod (or an old "iPad"-UA iPad) — i.e. an
 * iOS device whose Safari/WebKit photo picker transcodes HEIC→JPEG when a file
 * input's `accept` omits `image/heic` (see `imageAccept` in `~/lib/image/heicMime`).
 *
 * Backed by `bowser` (promoted to a direct dep from a transitive AWS-SDK one, so
 * an SDK bump can't drop it) rather than a hand-rolled UA regex, so the parsing
 * stays maintained. Modern iPadOS reports a *Macintosh*
 * UA indistinguishable from a desktop Mac, so no pure-UA check can flag it —
 * bowser (and therefore we) treat such iPads as non-iOS. That is a deliberate,
 * safe no-op: those iPads upload raw HEIC and fall back to the server-side
 * `heic_transcode` worker exactly as today, and we never risk the dangerous
 * direction — a false positive flagging a real desktop Mac (or Android) as iOS,
 * which would grey-out HEIC selection in its file dialog.
 */
export function isIOSUserAgent(userAgent: string): boolean {
  if (!userAgent) return false
  return Bowser.getParser(userAgent).isOS('iOS')
}
