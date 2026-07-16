import { describe, expect, it } from 'vitest'
import {
  contentDispositionAttachment,
  joinFilename,
  replacePathnameBasename,
  safeFilename,
  splitExtension,
} from './filename'

describe('splitExtension', () => {
  it('splits a simple filename', () => {
    expect(splitExtension('manual.pdf')).toEqual({ base: 'manual', extension: 'pdf' })
  })

  it('takes only the last segment for multi-dot names', () => {
    expect(splitExtension('archive.tar.gz')).toEqual({ base: 'archive.tar', extension: 'gz' })
  })

  it('returns no extension when there is no dot', () => {
    expect(splitExtension('README')).toEqual({ base: 'README', extension: null })
  })

  it('treats a leading dot as part of the base (dotfiles)', () => {
    expect(splitExtension('.gitignore')).toEqual({ base: '.gitignore', extension: null })
  })

  it('returns no extension for a trailing dot', () => {
    expect(splitExtension('photo.')).toEqual({ base: 'photo.', extension: null })
  })

  it('preserves case', () => {
    expect(splitExtension('Report.PDF')).toEqual({ base: 'Report', extension: 'PDF' })
  })

  it('handles Swedish base names', () => {
    expect(splitExtension('Båtbottenmålning 2024.pdf')).toEqual({
      base: 'Båtbottenmålning 2024',
      extension: 'pdf',
    })
  })
})

describe('joinFilename', () => {
  it('joins base and extension', () => {
    expect(joinFilename({ name: 'manual', extension: 'pdf' })).toBe('manual.pdf')
  })

  it('returns the base when there is no extension', () => {
    expect(joinFilename({ name: 'README', extension: null })).toBe('README')
    expect(joinFilename({ name: 'README' })).toBe('README')
  })

  it('round-trips with splitExtension', () => {
    for (const filename of ['manual.pdf', 'archive.tar.gz', 'README', '.gitignore', 'photo.']) {
      const { base, extension } = splitExtension(filename)
      expect(joinFilename({ name: base, extension })).toBe(filename)
    }
  })
})

describe('safeFilename', () => {
  it('transliterates Swedish characters to ASCII', () => {
    expect(safeFilename('Båtmanual.pdf')).toBe('Batmanual.pdf')
    expect(safeFilename('Övrigt')).toBe('Ovrigt')
    expect(safeFilename('Ärende')).toBe('Arende')
    expect(safeFilename('Höör Åsa.pdf')).toBe('Hoor-Asa.pdf')
  })

  it('collapses runs of illegal characters to a single dash', () => {
    expect(safeFilename('a/b c:d.pdf')).toBe('a-b-c-d.pdf')
  })

  it('keeps allowed characters (letters, digits, . _ -) intact', () => {
    expect(safeFilename('manual_v2.0-final.pdf')).toBe('manual_v2.0-final.pdf')
  })

  it('caps the result at 200 characters', () => {
    expect(safeFilename('a'.repeat(300))).toHaveLength(200)
  })
})

describe('replacePathnameBasename', () => {
  it('swaps the basename, preserving the directory prefix', () => {
    expect(replacePathnameBasename('prod/documents/uuid/old.pdf', 'new.pdf')).toBe(
      'prod/documents/uuid/new.pdf',
    )
  })

  it('treats a slash-less pathname as a bare basename', () => {
    expect(replacePathnameBasename('old.pdf', 'new.pdf')).toBe('new.pdf')
  })
})

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
