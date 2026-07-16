// The editor's photo view-model. The form field holds an ordered FormPhoto[] (the
// single source of truth for membership + order). 'existing' carries display data
// (url/blurhash) read-only; 'new' carries the local preview + upload status. Submit
// maps to the procedure shapes via the helpers below. A new photo has no `pathname`
// until its upload resolves — that's how we know an upload is still in flight.
export type FormPhoto =
  // url is null for an existing photo whose transcode is pending/failed (no
  // displayable URL yet); the editor renders no preview for it until task 11.
  | { kind: 'existing'; photoId: string; url: string | null; blurhash: string | null }
  | {
      kind: 'new'
      localId: string
      pathname?: string
      sizeBytes: number
      previewUrl: string
      // True while a server-side HEIC preview transcode is in flight (iPhone HEICs
      // have no embedded JPEG to preview locally). Drives the tile's "processing"
      // look instead of the neutral add-photo placeholder.
      previewLoading?: boolean
      status: 'uploading' | 'done' | 'error'
    }

export function photoKey(p: FormPhoto): string {
  return p.kind === 'existing' ? p.photoId : p.localId
}

export function photosUploading(photos: FormPhoto[]): boolean {
  return photos.some((p) => p.kind === 'new' && p.status !== 'done')
}

/** create input: all photos are freshly uploaded (must be 'done' with a pathname). */
export function toCreatePhotos(photos: FormPhoto[]): { pathname: string; sizeBytes: number }[] {
  return photos.flatMap((p) =>
    p.kind === 'new' && p.pathname ? [{ pathname: p.pathname, sizeBytes: p.sizeBytes }] : [],
  )
}

/** update input: existing kept by id + new uploads, preserving order. */
type UpdatePhoto =
  | { kind: 'existing'; photoId: string }
  | { kind: 'new'; pathname: string; sizeBytes: number }

export function toUpdatePhotos(photos: FormPhoto[]): UpdatePhoto[] {
  return photos.flatMap<UpdatePhoto>((p) => {
    if (p.kind === 'existing') return [{ kind: 'existing', photoId: p.photoId }]
    return p.pathname ? [{ kind: 'new', pathname: p.pathname, sizeBytes: p.sizeBytes }] : []
  })
}
