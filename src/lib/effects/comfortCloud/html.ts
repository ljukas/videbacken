import { Parser } from 'htmlparser2'

/**
 * The `<input type="hidden">` fields of an Auth0 page, name → value, entities decoded (`wctx` is
 * entity-encoded JSON). A Map, not an object: the names come from a remote page. The values can
 * be tokens: never log them.
 */
export function hiddenInputs(html: string): Map<string, string> {
  const inputs = new Map<string, string>()
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (name === 'input' && attribs.type?.toLowerCase() === 'hidden' && attribs.name) {
          inputs.set(attribs.name, attribs.value ?? '')
        }
      },
    },
    { decodeEntities: true },
  )
  parser.end(html)
  return inputs
}

/** Auth0 Guardian's hosted MFA widget (`window.__g_config = {…}`), detected as upstream starts. */
export function hasGuardianConfig(html: string): boolean {
  return html.includes('__g_config')
}
