import type { ShareCode } from './codes'

// Map each share to its themed CSS variable. The actual color values live in
// src/styles/app.css under :root / .dark so they flip with the active theme.
// Tailwind utilities `bg-share-a` etc. are wired via @theme inline and should
// be preferred when the share code is statically known; this map is for cases
// where the code is dynamic (e.g. inline `style={{ background: ... }}`).
export const shareColors: Record<ShareCode, string> = {
  A: 'var(--share-a)',
  B: 'var(--share-b)',
  C: 'var(--share-c)',
  D: 'var(--share-d)',
  E: 'var(--share-e)',
  F: 'var(--share-f)',
  G: 'var(--share-g)',
  H: 'var(--share-h)',
  I: 'var(--share-i)',
  J: 'var(--share-j)',
}

export const shareBackgroundClass: Record<ShareCode, string> = {
  A: 'bg-share-a',
  B: 'bg-share-b',
  C: 'bg-share-c',
  D: 'bg-share-d',
  E: 'bg-share-e',
  F: 'bg-share-f',
  G: 'bg-share-g',
  H: 'bg-share-h',
  I: 'bg-share-i',
  J: 'bg-share-j',
}
