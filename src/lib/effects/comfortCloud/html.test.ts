import { expect, test } from 'vitest'
import { hasGuardianConfig, hiddenInputs } from './html'

test('reads hidden inputs with entities decoded, whatever the case or quoting', () => {
  const inputs = hiddenInputs(`<form action="https://authglb.digital.panasonic.com/login/callback">
    <input type="hidden" name="wa" value="wsignin1.0">
    <input type="hidden" name="wresult" value="abc&amp;def&quot;">
    <INPUT TYPE="Hidden" NAME="wctx" VALUE='{"strategy":"auth0"}'>
    <input type="hidden" name="wctx2" value="{&#34;a&#34;:1}">
    <input type="hidden" name="empty">
    <input type="text" name="username" value="not-hidden">
    <input type="hidden" value="no-name">
  </form>`)
  expect(Object.fromEntries(inputs)).toEqual({
    wa: 'wsignin1.0',
    wresult: 'abc&def"',
    wctx: '{"strategy":"auth0"}',
    wctx2: '{"a":1}',
    empty: '',
  })
})

test('a remote name like __proto__ is just a key', () => {
  const inputs = hiddenInputs('<input type="hidden" name="__proto__" value="x">')
  expect(inputs.get('__proto__')).toBe('x')
  expect(({} as Record<string, unknown>).x).toBeUndefined()
})

test('no inputs in a page without a form', () => {
  expect(hiddenInputs('<html><body>Hi</body></html>').size).toBe(0)
})

test('spots the Auth0 Guardian MFA widget config', () => {
  expect(hasGuardianConfig('<script>window.__g_config = { requestToken: "x" }</script>')).toBe(true)
  expect(hasGuardianConfig('<html><form></form></html>')).toBe(false)
})
