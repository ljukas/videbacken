# Recommended Places — Seam Map (feature-workflow Phase 1)

> **What this is.** The result of Phase 1 ("Understand the seams") for the Recommended Places feature ([ADR-0012](../../adr/0012-recommended-places.md)). It maps the *real, current* code shapes the feature reuses, so each slice plan can reference accurate signatures and line numbers instead of re-deriving them. Produced 2026-06-28 from five parallel code-explorer passes.
>
> **How to use it.** Each slice plan in this directory (`01-…`, `02-…`) cites the relevant rows below. When a cited file moves or its signature changes, update the line ref here, not in every plan.

---

## Reuse list (what to copy, and from where)

| Seam | Reuse | Key files |
|---|---|---|
| **Upload byte-path** | `runUploadFlow` per photo in a loop; mint → PUT → confirm; `file` row insert shape | `src/lib/effects/storage/clientUpload.ts:65`, `src/lib/orpc/procedures/image.ts:21,38`, `src/lib/services/file/file.ts:71` |
| **Image render** | `<Avatar>`+`<AvatarImage>` for the orb; `<Image transformer={transformer} breakpoints={snapBreakpoints(w)}>` for gallery/full; `blurhashToCssGradientString` placeholder | `src/components/ui/avatar.tsx:43`, `src/lib/image/transformer.ts`, `src/lib/image/sizes.ts` |
| **Blurhash** | add `'recommendation'` kind to the payload union; publish behind `SHARP_DECODABLE_MIME_SET` guard | `src/lib/effects/queue/queue.ts:33` (edit), `src/lib/queue/handlers/blurhash.ts` (no change — falls through like `'document'`) |
| **Service + code-only errors** | `errors.ts` class+code union; check-first guarded ops in `db.transaction`; `DbOrTx` type | `src/lib/services/folder/{errors,folder,index}.ts`, `src/lib/services/document/document.ts` |
| **Procedure glue** | `xErrors satisfies Record<Code,{status}>` + `.errors()`; `catch (err instanceof XDomainError) throw errors[err.code]()`; spread boundary codes | `src/lib/orpc/procedures/folder.ts:11`, `src/lib/orpc/procedures/document.ts:55`, register in `src/lib/orpc/router.ts` |
| **Client error map** | `import type` code union + exhaustive `switch`→`m.*()`; `isDefinedError(e)` narrows `e.code` | `src/lib/orpc/folderErrorMessage.ts`, `src/components/document/dialogs/RenameFolderDialog.tsx` |
| **Schema / migration** | inline `timestamp(...,{withTimezone:true})`, `$onUpdate`, `check()`, partial indexes, `doublePrecision`, `pgEnum`; `casing:'snake_case'`; seed migration | `src/lib/db/schema/{file,folder,document,ownership}.ts`, `drizzle/0002_seed_share_parts.sql` |
| **Realtime** | add `recommendation.changed` arm to the union + `useRealtimeSync` dispatch; `publish(..., {source: context.user.id})` after the service call | `src/lib/effects/realtime/types.ts:7`, `src/hooks/useRealtimeSync.ts`, `src/lib/orpc/procedures/folder.ts:44` |
| **Forms** | `useAppForm`; raw `<form.AppField>` render-prop for custom pickers; `useUrlDialog`+`ResponsiveDialog` for the detail dialog | `src/hooks/form.ts`, `src/components/login/LoginFormCard.tsx`, `src/components/form/SelectField.tsx`, `src/hooks/useUrlDialog.ts`, `src/components/document/dialogs/CreateFolderDialog.tsx` |

---

## Load-bearing shapes (copy-paste grounded)

### 1. Upload byte-path (Slices 1 & 3)

`runUploadFlow` is already built for loop reuse (avatar = 1 file, documents = N). Signature (`clientUpload.ts:65`):

```ts
runUploadFlow<M extends MintUploadResult>(file, {
  access: 'public' | 'private',
  contentType: string,
  mint: () => Promise<M>,                 // caller owns the exact request shape
  confirm: (minted: M) => Promise<unknown>,
  onProgress?: (p: UploadProgress) => void,
})
```

Per-photo client shape (read EXIF first — see Gotchas):

```ts
// for each chosen file (after the EXIF pass + HEIC transcode):
const mint = await orpc.recommendation.mintImageUpload.mutateAsync({ contentType, sizeBytes, fileName })
await uploadFileToStorage(file, mint, { access: 'public', contentType })
photos.push({ pathname: mint.pathname, mime: contentType, sizeBytes })
// then:
orpc.recommendation.create.mutateAsync({ title, description, lat, lng, tagIds, photos })
```

The `create` procedure verifies **each** photo: `stripEnvPrefix(pathname).startsWith('recommendations/{userId}/')` + `storage.head('public', pathname)`, then one tx: `recommendation` → N `file` rows → N `recommendation_photo` rows → M `recommendation_tag`. `file` insert columns (`file.ts:83`): `{ ownerId, pathname, mime, sizeBytes, access: 'public' }` (`blurhash` filled later by the worker; `mime` = `storage.head().contentType`).

`mintAvatarUpload` input (`image.ts:21`) to mirror: `{ contentType: z.enum([...image mimes]), sizeBytes: z.number().int().positive().max(N), name: z.string().min(1).max(255) }`.

### 2. Image render (Slices 2 & 4)

Orb (~64px, circular) — reuse `<Avatar>`+`<AvatarImage>` (`avatar.tsx:43`) directly. Gallery thumb / full — `<Image>` from `@unpic/react/base`:

```tsx
const gradient = useMemo(() => (blurhash ? blurhashToCssGradientString(blurhash) : undefined), [blurhash])
<Image src={photoUrl} alt={title} width={400} height={300} background={gradient}
  layout="constrained" breakpoints={snapBreakpoints(400)} transformer={transformer}
  className="w-full rounded-md object-cover" />
```

`snapBreakpoints(w)` → `[snapUp(w), snapUp(w*2)]`: 64→`[64,128]`, 400→`[640,828]`, 2048→`[2048,3840]` (`sizes.ts`). Transformer passes through in DEV; routes public-blob URLs via `/_vercel/image?url=…&w=…` in prod (`transformer.ts`). `IMAGE_SIZES` is also the Vercel optimizer allowlist in `vite.config.ts` — every requested width must be in it (all the above are).

### 3. Blurhash kind (Slice 1)

Payload union (`queue.ts:33`) — add one arm:

```ts
blurhash:
  | { fileId: string; kind: 'avatar'; userId: string }
  | { fileId: string; kind: 'document' }
  | { fileId: string; kind: 'recommendation' }   // ← add
```

Handler (`blurhash.ts`) needs **no change** — the `if (msg.kind === 'avatar')` denormalization block falls through for `recommendation` exactly like `document`. (Optional: add an explicit `else if (kind === 'document' || kind === 'recommendation')` for exhaustiveness.) Publish from the create procedure behind the same guard documents use:

```ts
if (SHARP_DECODABLE_MIME_SET.has(blob.contentType)) {
  await queue.publish('blurhash', { fileId: inserted.fileId, kind: 'recommendation' }).catch(/* log */)
}
```

No `image_thumbnail` publish (ADR-0012: no thumbnail worker; sizes come from the transformer).

### 4. Service + code-only errors (Slice 1, 4, 5)

`errors.ts` skeleton (`folder/errors.ts`):

```ts
export type RecommendationDomainErrorCode = 'NOT_FOUND' | 'CANNOT_EDIT_OTHERS' | 'CANNOT_DELETE_OTHERS' | 'NO_PHOTOS' | 'TOO_MANY_PHOTOS'
export class RecommendationDomainError extends Error {
  constructor(public readonly code: RecommendationDomainErrorCode) { super(code); this.name = 'RecommendationDomainError' }
}
```

Guarded op (check-first, in a tx; `document.ts:446`/`folder.ts:200`):

```ts
return db.transaction(async (tx) => {
  const [row] = await tx.select(cols).from(recommendation).where(eq(recommendation.id, id)).limit(1)
  if (!row) throw new RecommendationDomainError('NOT_FOUND')
  if (actorRole !== 'admin' && row.authorId !== actorId) throw new RecommendationDomainError('CANNOT_EDIT_OTHERS')
  // …mutate…
})
```

`DbOrTx` type (declared once per service file, `folder.ts:9`) lets a service op accept either `db` or an in-flight `tx` for nested calls. `db` is always the singleton: `import { db } from '~/lib/db'`. Barrel `index.ts`: `export * from './errors'; export * from './recommendation'`.

### 5. Procedure glue (Slice 1+)

```ts
export const recommendationErrors = {
  NOT_FOUND: { status: 404 }, CANNOT_EDIT_OTHERS: { status: 403 }, /* … */
} satisfies Record<RecommendationDomainErrorCode, { status: number }>

create: protectedProcedure
  .errors({ ...recommendationErrors, INVALID_PATH: { status: 403 }, FILE_NOT_IN_STORAGE: { status: 404 } })
  .input(z.object({ /* … */ }))
  .handler(async ({ input, context, errors }) => {
    // boundary checks throw errors.INVALID_PATH() / errors.FILE_NOT_IN_STORAGE() directly
    let result
    try { result = await recommendationService.create({ /* …actorId, actorRole… */ }) }
    catch (err) { if (err instanceof RecommendationDomainError) throw errors[err.code](); throw err }
    await queue.publish('blurhash', /* … */).catch(/* log */)
    await realtime.publish({ kind: 'recommendation.changed', ids: [result.id] }, { source: context.user.id })
    return result
  })
```

Access levels (`context.ts:47`): `publicProcedure` / `protectedProcedure` (`context.user` set) / `adminProcedure`. Reads (`list`, `get`, `tag.list`) need no `.errors(...)`. Register in `router.ts`: one import + `recommendation: recommendationRouter`. The router key becomes the `orpc.recommendation.*` query namespace.

### 6. Client error map (Slice 1+)

```ts
import type { RecommendationDomainErrorCode } from '~/lib/services/recommendation'
import { m } from '~/paraglide/messages'
export function recommendationErrorMessage(code: RecommendationDomainErrorCode): string {
  switch (code) { /* exhaustive, no default */ case 'NOT_FOUND': return m.recommendation_error_not_found(); /* … */ }
}
```

Consume with `isDefinedError(e)` to narrow `e.code` (`RenameFolderDialog.tsx`): inline a field error for user-fixable codes, `toast.error(recommendationErrorMessage(e.code))` otherwise. Reuse `m.common_error_admin_only()` for admin-only codes.

### 7. Schema / migration (Slice 1)

Conventions (camelCase in TS → snake_case in DB via `casing:'snake_case'` in both `drizzle.config.ts:18` and `db/index.ts:22`):

- PK: `uuid('id').primaryKey().defaultRandom()`
- created: `timestamp('created_at', { withTimezone: true }).defaultNow().notNull()`
- updated: `+ .$onUpdate(() => new Date())`
- soft-delete: `timestamp('deleted_at', { withTimezone: true })` (nullable)
- check: `check('name', sql\`${table.col} BETWEEN -90 AND 90\`)` in the table callback
- index: `index('name').on(table.col)`; partial: `.where(sql\`${table.deletedAt} IS NULL\`)`; unique: `uniqueIndex('name').on(...)`
- FK: `.references(() => x.id, { onDelete: 'cascade' | 'restrict' | 'set null' })`
- coords: `doublePrecision('lat')` (import from `drizzle-orm/pg-core`)
- **composite PK**: `primaryKey({ columns: [t.a, t.b] })` (import `primaryKey` from `drizzle-orm/pg-core`)

Barrel: add `export * from './recommendation'` to `schema/index.ts`. Generate: `pnpm db:generate --name=add_recommendation_tables && pnpm db:migrate`. Seed tags: `pnpm drizzle-kit generate --custom --name=seed_system_tags`, then hand-write `INSERT INTO "tag" (...) VALUES (...) ON CONFLICT DO NOTHING;` (idempotent — see `drizzle/0002_seed_share_parts.sql`). New tables get `timestamptz` directly; the `USING … AT TIME ZONE 'UTC'` gotcha (`drizzle/0006`) only applies to *altering* existing columns.

### 8. Realtime (Slice 1)

Union arm (`types.ts:7`): `z.object({ kind: z.literal('recommendation.changed'), ids: z.array(z.string()).optional() })`.
Dispatch arm (`useRealtimeSync.ts`): `case 'recommendation.changed': void queryClient.invalidateQueries({ queryKey: orpc.recommendation.key() }); return`.
Publish after the service call (`folder.ts:44`): `await realtime.publish({ kind: 'recommendation.changed', ids: [id] }, { source: context.user.id })` — `source` suppresses the actor's own SSE echo. Like/comment/reorder all publish the same single event.

### 9. Forms (Slices 3 & 5)

`useAppForm` (`form.ts`) binds field components: `TextField`, `FloatingTextField`, `FloatingPhoneField`, `SelectField`, `PhoneField`, `ToggleField`, `DateField`, `UserSelectField`; form components `SubmitButton`, `CancelButton`. Canonical usage (`LoginFormCard.tsx:24`):

```tsx
const form = useAppForm({ defaultValues, validators: { onSubmit: zodSchema }, onSubmit: async ({ value }) => {…} })
<form onSubmit={(e) => { e.preventDefault(); form.handleSubmit() }}>
  <form.AppField name="title">{(field) => <field.TextField label={…} />}</form.AppField>
  <form.AppForm><form.SubmitButton label={…} /></form.AppForm>
</form>
```

Custom-picker escape hatch (raw render-prop — **no `useState`**; the form owns the value):

```tsx
<form.AppField name="photos">
  {(field) => <PhotoGalleryEditor value={field.state.value} onChange={(v) => field.handleChange(v)} />}
</form.AppField>
```

Inside a bound field: `field.state.value`, `field.handleChange(v)`, `field.state.meta.{isTouched,isValid,errors}`, `field.name` (see `SelectField.tsx:21`). Detail dialog → `useUrlDialog` (`hooks/useUrlDialog.ts`) + `ResponsiveDialog` (model on `CreateFolderDialog.tsx`). The create/edit **editor is a dedicated route** (`/recommendations/new`, `/recommendations/$id/edit`) per ADR-0013, not an overlay.

---

## Corrections caught in exploration (do NOT let these reach the plan)

- **Composite PK syntax**: `primaryKey({ columns: [a, b] })` from `drizzle-orm/pg-core` — *not* the `{ pk: {...} }` object one explorer improvised. Applies to `recommendation_tag`, `recommendation_like`.
- **Soft-delete partial index**: `WHERE deleted_at IS NULL` (index active rows for list queries) — *not* `IS NOT NULL`.
- **Column name**: `authorId` / `author_id` consistently (one explorer example drifted to `createdBy`).
- **EXIF ordering**: read `exifr.gps(originalFile)` in a **first pass** over all chosen files (first photo with GPS wins) **before** any HEIC transcode — transcode strips EXIF.
- **`mime` source**: insert `storage.head().contentType`, not the client's claimed mime (mirror `confirmAvatarUpload`).
- **Photo cleanup**: `recommendation_photo.file_id` is `unique` + `onDelete:'restrict'` → photo removal flows through the service (soft-delete the `file` row), never an FK cascade.

## The one genuinely new seam: the map

No existing code to copy. New deps: `maplibre-gl`, `@vis.gl/react-maplibre`, `exifr` (`@unpic/placeholder` already ships with avatars). The map component is **client-only** (mounted-guard returning a same-shape placeholder, never `null`; add the libs to `ssr.external` in `vite.config.ts`; import `maplibre-gl/dist/maplibre-gl.css` once). Build it fresh against current `@vis.gl/react-maplibre` docs (pull via Context7/WebFetch at Slice 2). Image *rendering* is covered by the avatar/transformer pattern above; the *map* itself is the net-new work, isolated to Slice 2+.

## Findings worth fixing separately (not blocking)

- **CLAUDE.md inaccuracy**: the code map lists `test/scope.ts` / `newScope()` for per-test prefixed ids/emails. **Neither exists.** Service tests call `setupDatabase()` from `~test/setup` at module scope and use inline `insertMember(email, name, role)` helpers with `@test.oceanview.local` emails (see `src/lib/services/folder/folder.test.ts:22`). Plans should follow the real pattern; CLAUDE.md should be corrected in a small docs PR.

## Slice readiness

**Slice 1 (data backbone) is fully grounded** — schema, services, code-only errors, procedures, the realtime arm, the blurhash kind, and the upload mint/confirm are all mapped to real current code with line refs. The net-new map work begins in Slice 2.
