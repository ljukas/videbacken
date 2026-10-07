// Client-safe. The body font (Switzer, ADR-0015), preloaded from the root head so
// it starts with the CSS instead of after it. Must match app.css's @font-face url
// (test/fonts.test.ts). Headings (Cabinet Grotesk) aren't preloaded: two 42 KB
// fonts would compete with the entry JS.
export const BODY_FONT_URL = '/fonts/switzer/Switzer-Variable.woff2'
