import { describe, expect, it } from 'vitest'
import { contentDispositionAttachment } from './filename'

describe('contentDispositionAttachment', () => {
  it('includes an ASCII fallback and a UTF-8 encoded form', () => {
    const value = contentDispositionAttachment('Motormanual.pdf')
    expect(value).toBe(`attachment; filename="Motormanual.pdf"; filename*=UTF-8''Motormanual.pdf`)
  })

  it('encodes Swedish characters and sanitizes the ASCII fallback', () => {
    const value = contentDispositionAttachment('Bottenmålning.pdf')
    expect(value).toContain(`filename="Bottenm_lning.pdf"`)
    expect(value).toContain(`filename*=UTF-8''Bottenm%C3%A5lning.pdf`)
  })

  it('neutralizes quotes and backslashes in the fallback', () => {
    const value = contentDispositionAttachment('a"b\\c.txt')
    expect(value).toContain(`filename="a_b_c.txt"`)
  })
})
