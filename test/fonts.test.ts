import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BODY_FONT_URL } from '~/lib/fonts'

// The preload only helps if it names the exact URL the @font-face loads;
// otherwise the browser downloads the font twice.
describe('BODY_FONT_URL', () => {
  it("is the URL app.css's Switzer @font-face loads", () => {
    const css = readFileSync('src/styles/app.css', 'utf8')
    const face = /@font-face\s*{[^}]*font-family:\s*'Switzer'[^}]*}/.exec(css)?.[0]
    expect(face).toBeDefined()
    expect(face).toContain(`url('${BODY_FONT_URL}')`)
  })

  it('exists under public/', () => {
    expect(existsSync(`public${BODY_FONT_URL}`)).toBe(true)
  })
})
