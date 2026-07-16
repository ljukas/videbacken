import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Accepts only same-origin absolute paths (`/foo`), never protocol-relative (`//evil`). */
export function sanitizeRedirect(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  return /^\/(?!\/)/.test(raw) ? raw : undefined
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const first = parts[0] ?? ''
  const last = parts.length > 1 ? (parts.at(-1) ?? '') : ''
  const combined = (first.charAt(0) + last.charAt(0)).toUpperCase()
  return combined || '?'
}
