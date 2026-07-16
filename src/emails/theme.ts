// Email Tailwind config for Oceanview's brand ("quiet nautical confidence",
// ADR-0015). The typographic scale + addUtilities plugin originate from Resend's
// react-email demo (apps/demo/emails/05-Studio, MIT — © 2024 Plus Five Five,
// Inc.); the colors and fonts are Oceanview's. Brand blue #156cdd is the sRGB of
// --brand oklch(0.56 0.18 256) in src/styles/app.css. Fonts are a system stack
// only: custom web fonts don't render in Gmail/Outlook, so we don't ship them.

import { pixelBasedPreset, type TailwindConfig } from 'react-email'
import plugin from 'tailwindcss/plugin'

const colors = {
  bg: '#EEF2F6', // light, faintly cool page behind the card
  card: '#FFFFFF',
  fg: '#1C1D1F', // near-black body/heading text
  'fg-muted': '#6B7280', // secondary / supporting text
  border: '#E6E9EE',
  brand: '#156CDD', // nautical-blue accent (CTA, logo mark)
  'brand-fg': '#FFFFFF', // text on the brand button
} as const

const fontScale = {
  11: { fontSize: '11px', lineHeight: '1.5', letterSpacing: '-0.11px' },
  13: { fontSize: '13px', lineHeight: '1.5', letterSpacing: '-0.13px' },
  14: {
    fontSize: '14px',
    lineHeight: '1.6',
    letterSpacing: '-0.042px',
    fontWeight: '450',
  },
  15: {
    fontSize: '15px',
    lineHeight: '1.6',
    letterSpacing: '-0.042px',
    fontWeight: '500',
  },
  16: { fontSize: '16px', lineHeight: '1.5', letterSpacing: '-0.16px' },
  18: { fontSize: '18px', lineHeight: '1.5', letterSpacing: '-0.11px' },
  20: { fontSize: '20px', lineHeight: '1.5', letterSpacing: '-0.1px' },
  22: {
    fontSize: '22px',
    lineHeight: '1.4',
    letterSpacing: '-0.176px',
    fontWeight: '500',
  },
  24: {
    fontSize: '24px',
    lineHeight: '1.4',
    letterSpacing: '-0.12px',
    fontWeight: '600',
  },
  32: {
    fontSize: '32px',
    lineHeight: '1.2',
    letterSpacing: '-0.64px',
    fontWeight: '500',
  },
  40: {
    fontSize: '40px',
    lineHeight: '1.2',
    letterSpacing: '-0.8px',
    fontWeight: '700',
  },
  48: {
    fontSize: '48px',
    lineHeight: '1.15',
    letterSpacing: '-0.96px',
    fontWeight: '700',
  },
  56: {
    fontSize: '56px',
    lineHeight: '1.2',
    letterSpacing: '-1.2px',
    fontWeight: '700',
  },
} as const

const fontSizeTheme = Object.fromEntries(
  Object.entries(fontScale).map(([step, t]) => [
    step,
    [t.fontSize, { lineHeight: t.lineHeight, letterSpacing: t.letterSpacing }] as [
      string,
      { lineHeight: string; letterSpacing: string },
    ],
  ]),
)

export const emailTailwindConfig: TailwindConfig = {
  // pixelBasedPreset emits px instead of rem so spacing utilities survive Outlook.
  presets: [pixelBasedPreset],
  plugins: [
    plugin(({ addVariant, addUtilities }) => {
      addVariant('mobile', '@media (max-width: 600px)')
      const utilities: Record<string, Record<string, string>> = {}
      for (const [step, token] of Object.entries(fontScale)) {
        utilities[`.font-${step}`] = token
      }
      addUtilities(utilities)
    }),
  ],
  theme: {
    extend: {
      fontSize: fontSizeTheme,
      colors,
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          'Helvetica',
          'Arial',
          'sans-serif',
        ],
      },
      boxShadow: {
        // soft elevation for the white card
        card: '0px 1px 2px rgba(16,24,40,0.04), 0px 8px 24px rgba(16,24,40,0.06)',
      },
    },
  },
}
