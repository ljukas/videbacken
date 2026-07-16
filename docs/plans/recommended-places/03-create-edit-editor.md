# Recommended Places — Slice 3: Create/Edit Editor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the write surface of Recommended Places (ADR-0012) — a dedicated **create/edit editor route** (`/recommendations/new`, `/recommendations/$id/edit`) with a multi-photo uploader (add / remove / drag-reorder, cover = first), a MapLibre **location picker** pre-filled from the first GPS-bearing photo's EXIF, and a tag multi-picker — plus **edit/delete** entry points in the detail dialog. This is the slice that lets owners actually put places on the map.

**Architecture:** The editor is a container-agnostic `RecommendationEditor` (`useAppForm`, ADR-0005) hosted on two dedicated routes (ADR-0013: complex/growing forms get a route, not an overlay), modeled on the `ShareAssignForm` + `shares.assign.$shareCode.tsx` precedent. **Slice 1 already shipped the whole backend** (services + `create`/`update`/`reorderPhotos`/`softDelete`/`mintImageUpload` procedures, the realtime arm, the `'recommendation'` blurhash kind, and the client error map) — so this slice is **mostly UI**, with exactly one backend change: `updateRecommendation` currently edits title/desc/lat/lng/tags only, so we **expand it to add/remove photos** (the desired full ordered photo set, diffed against current — TDD, the testable heart of the slice). Photos ride the proven avatar byte-path (`runUploadFlow` per file, mint→PUT, then the pathname is submitted in `create`/`update`); EXIF GPS is read client-side with `exifr` on the **original** file **before** the HEIC transcode that would strip it. Reorder is persisted by `update` (the form holds the full ordered set), not a separate `reorderPhotos` call.

**Tech Stack:** `@dnd-kit/sortable` (drag-reorder; `@dnd-kit/core`/`utilities`/`accessibility` already deps), `exifr` (client-side EXIF GPS), `@vis.gl/react-maplibre` + `maplibre-gl` (location-picker map, already deps), `heic-to` (already a dep), `@tanstack/react-form` (`useAppForm`), TanStack Router (dedicated routes, `useCanGoBack`) + TanStack Query, shadcn/ui (`textarea`, `toggle-group`, `badge`, `alert-dialog`, `button` — all already present), Paraglide i18n.

**Companion docs (read first):**
- Design: [`docs/adr/0012-recommended-places.md`](../../adr/0012-recommended-places.md) (esp. Decision §§3–6, §8, §10; "Storage / EXIF flow"; "UI surface" → editor; Build-sequence Slice 3 row).
- **Seam map (cited as "seam map §N"):** [`00-seam-map.md`](./00-seam-map.md) — §1 upload byte-path, §9 forms.
- **Slice 1 (the backbone this consumes):** [`01-data-backbone.md`](./01-data-backbone.md).
- **Slice 2 (the read surface this extends):** [`02-map-and-detail-read-only.md`](./02-map-and-detail-read-only.md).
- Forms: [`docs/adr/0005-form-architecture.md`](../../adr/0005-form-architecture.md). Form presentation / dedicated routes: [`docs/adr/0013-form-presentation-and-dialog-architecture.md`](../../adr/0013-form-presentation-and-dialog-architecture.md).
- Empty-state CTA: [`docs/adr/0016-empty-state-and-feedback-conventions.md`](../../adr/0016-empty-state-and-feedback-conventions.md).
- Mutation-callback placement (pessimistic vs optimistic close): CLAUDE.md → "Mutation callback placement & optimistic close".

## Global Constraints

Every task implicitly includes these (CLAUDE.md Non-negotiables + the ADRs above):

- **New npm dependencies — only these two:** `exifr` and `@dnd-kit/sortable`. (`@dnd-kit/core`, `@dnd-kit/utilities`, `@dnd-kit/accessibility`, `maplibre-gl`, `@vis.gl/react-maplibre`, `embla-carousel-react`, `heic-to` are already deps.) `@dnd-kit/sortable` pulls `@dnd-kit/utilities` (already present). No others.
- **No DB migration in this slice.** The photo-editing change is pure service logic over the existing `recommendation` / `recommendation_photo` / `file` / `recommendation_tag` tables (no new columns). **migration-guard is therefore N/A** — but if you find yourself editing `src/lib/db/schema/` or `drizzle/`, stop: you've gone off-plan.
- **All DB access through the service** (ADR-0002). The procedure stays thin glue: it heads/verifies new photo blobs (effect), maps domain errors to status-only typed oRPC errors, and runs side effects (blurhash enqueue, `realtime.publish`) after success. Services never import effects.
- **Reuse the avatar byte-path verbatim** (seam map §1): `runUploadFlow(file, { access:'public', contentType, mint, confirm })` per photo; HEIC transcode via the shared helpers (extracted in Task 1); the mint procedure (`recommendation.mintImageUpload`) and the per-photo `storage.head` ownership/existence verification already exist. **No new storage code, no `confirmPhotoUpload` procedure** — the pathname is submitted as part of `create`/`update` input.
- **EXIF before transcode** (ADR-0012 §4; seam map "Corrections caught in exploration"): read `exifr.gps(originalFile)` on each chosen file **before** `transcodeHeicToJpeg`, because the transcode strips metadata. The **first** photo with coordinates wins; location stays editable; no photo with GPS → manual placement on Lefkada.
- **Forms via `useAppForm`** (ADR-0005): never `useState` for **field values**. Custom pickers (photos, location, tags) wire through raw `<form.AppField>` render-props pushing values with `field.handleChange(...)`. Per-upload progress % and the file-input ref are transient *presentation* state (local `useState`/`useRef`), exactly as `AvatarUpload` keeps `progress` local — that is **not** a field value and is allowed.
- **Pessimistic submit for the editor** (CLAUDE.md mutation guidance): create/edit can fail server-side (`INVALID_PATH` / `FILE_NOT_IN_STORAGE`) and a multi-photo form is expensive to re-enter, so **await** the mutation, navigate only on success, and on error `toast.error(...)` and **stay on the form** (don't lose input). **Delete** (in the detail dialog) has no user-fixable failure and nothing to lose → **optimistic instant-close** (callbacks in `mutationOptions`, `optimisticRemove` + close, invalidate on settle).
- **Realtime is already wired** (slice 1): every mutating procedure publishes `recommendation.changed`; `useRealtimeSync` invalidates `orpc.recommendation.key()`. This slice adds nothing to realtime.
- **Access model** (ADR-0012 §10): **create** = any authenticated owner; **edit/delete** = author-or-admin (enforced in the service; the edit route also guards and redirects, and the detail dialog only shows edit/delete to author-or-admin). Reads stay auth-only.
- **Responsive on every screen** (CLAUDE.md): the editor uses the standard `PageContainer width="prose"` form column; the photo strip wraps/scrolls; the location-picker map gets a responsive height (no fixed px) with ≥44px drag targets; the dnd-kit sortable uses both pointer **and** keyboard sensors (a11y).
- **i18n via Paraglide** — all strings in `messages/sv.json` (source of truth, informal "du") + `messages/en.json` (key-complete). Store the message **function** at module scope, call at render. After editing messages outside `pnpm dev`: `pnpm i18n:compile`. Route URLs stay English (`/recommendations/new`, `/recommendations/$id/edit`).
- **Component placement & naming**: feature components in `src/components/recommendation/` (PascalCase); helpers in `src/lib/files/` (camelCase) and `src/lib/image/`; routes follow TanStack file-naming (`recommendations.new.tsx`, `recommendations.$id.edit.tsx`). `src/components/ui/` is shadcn-managed (kebab-case) — don't normalize. **No new `shadcn add`** is needed (textarea/toggle-group/badge/alert-dialog/carousel all exist).
- **Conventional Commits** per task; one concern per PR (this whole plan = one slice PR).

## Decisions baked into this plan (flagged for the reviewer)

- **Combined create + edit in one slice** (matches the ADR's Slice 3 grouping). The marginal backend cost is the `updateRecommendation` photo-set expansion (Task 3, TDD); the form component is shared between modes.
- **Drag-and-drop reorder via `@dnd-kit/sortable`** (ADR-0012 says "reorderable (drag)"; the "UX polish is worth machinery" rule applies — reorder is user-facing UX, not defensive infra). `@dnd-kit/core` is already in the tree (document DnD), so this adds one small package.
- **Reorder is saved by `update`, not `reorderPhotos`.** The editor holds the full ordered photo set in the form and persists order on Save. The slice-1 `reorderPhotos` procedure stays available (e.g. a future inline map reorder) but is **intentionally unused** by the editor — one Save = one atomic `update` tx.
- **`geo.ts` / Haversine is deferred to Slice 6** (its only consumer is the nearest-me list sort). The ADR table lists it under Slice 3, but building a tested helper with no caller is YAGNI; Slice 6 adds it where it's used. *(This deviates from the ADR's helper-grouping — noted intentionally.)*
- **Uploads happen on photo-add** (the avatar pattern), so abandoning the form can orphan public blobs with no `recommendation_photo` row. Accepted at this scale (≈20 users), consistent with the soft-delete-only posture (no `storage.delete` in services); a future bin/GC can reclaim them.
- **Removing a photo soft-deletes its `file` row** (`deletedAt`) and deletes the `recommendation_photo` join row; it does **not** delete bytes (mirrors `softDeleteRecommendation`, branch-safe per ADR-0006's prod-origin-files note).

**Out of scope (later slices — do not build):** likes + orb premiering (Slice 4); comments (Slice 5); the list view, map⇄list toggle, sorts, `geo.ts`/Haversine, and the map tag-filter row (Slice 6).

---

## File Structure

**Create:**
- `src/lib/image/heic.ts` — extracted `isHeicCandidate` + `transcodeHeicToJpeg` (shared by `AvatarUpload` and the new uploader).
- `src/lib/files/exif.ts` — `readGpsFromFile(file)` → `{ lat, lng } | null` (wraps `exifr.gps`).
- `src/components/recommendation/mapConfig.ts` — shared `LEFKADA` view + `mapStyleUrl()` (de-dupes the MapTiler URL between map + picker).
- `src/components/recommendation/TagPicker.tsx` — multi-select toggle over `orpc.tag.list`.
- `src/components/recommendation/PhotoUploader.tsx` — multi-photo add/remove/drag-reorder; `runUploadFlow` per file; EXIF surfaced via callback.
- `src/components/recommendation/LocationPicker.tsx` — **client-only, default-export** mini MapLibre map with a draggable marker / tap-to-place.
- `src/components/recommendation/RecommendationEditor.tsx` — the `useAppForm` form, container-agnostic, create + edit modes.
- `src/components/recommendation/recommendationFormTypes.ts` — the `FormPhoto` view-model + the `toCreatePhotos`/`toUpdatePhotos` submit mappers (shared by editor + uploader, keeps the form value typed).
- `src/routes/_authenticated/recommendations.new.tsx` — create route.
- `src/routes/_authenticated/recommendations.$id.edit.tsx` — edit route (author-or-admin guard).

**Modify:**
- `src/lib/services/recommendation/recommendation.ts` — expand `updateRecommendation` to take the desired photo set (add/remove + reorder); return `newPhotoFileIds`.
- `src/lib/services/recommendation/recommendation.test.ts` — new photo-edit tests; amend the 3 existing `updateRecommendation` tests for the new `photos` arg.
- `src/lib/orpc/procedures/recommendation.ts` — expand the `update` procedure input (discriminated photo array) + handler (head new photos, enqueue blurhash for new, `.errors` += INVALID_PATH/FILE_NOT_IN_STORAGE).
- `src/components/user/AvatarUpload.tsx` — import the HEIC helpers from `~/lib/image/heic` instead of inlining them (behavior-preserving).
- `src/components/recommendation/RecommendationMap.tsx` — import `LEFKADA`/`mapStyleUrl` from `mapConfig` (de-dupe).
- `src/components/recommendation/RecommendationDetailDialog.tsx` — add author-or-admin **Edit** (link) + **Delete** (AlertDialog → `softDelete`) actions.
- `src/routes/_authenticated/recommendations.tsx` — add the "Add place" CTA (empty-state primary action + header button).
- `package.json` / `pnpm-lock.yaml` — `exifr`, `@dnd-kit/sortable`.
- `messages/sv.json`, `messages/en.json` — editor/field/validation/action/toast keys.

**Dependency spine (task order):** deps + HEIC extract (1) → `exif.ts` leaf (2) → **service photo-edit + tests (3)** → procedure expand (4) → i18n (5) → `mapConfig` + `TagPicker` (6) → `PhotoUploader` (7) → `LocationPicker` (8) → `RecommendationEditor` (9) → create route + entry CTAs (10) → edit route + detail-dialog actions (11) → wrap-up + live verify (12).

**Review checkpoints (feature-workflow Phase 5):**
- **migration-guard: N/A** (no schema/migration change — see Global Constraints).
- After **Task 3**: run the **`test-completeness`** agent — every `RecommendationDomainError.code` exercised by `updateRecommendation` must have a test (the photo-edit paths reuse `NO_PHOTOS`/`TOO_MANY_PHOTOS`/`DUPLICATE_PHOTOS`/`NOT_FOUND`/`CANNOT_EDIT_OTHERS_RECOMMENDATION` — no new codes, so no client-error-map change).
- After **Tasks 6–11** (the TSX): load/run **`vercel:react-best-practices`** (memoized sortable items, no `useState` for field values, `ClientOnly`/`lazy` for the map, effect hygiene).
- Before the PR: **`code-reviewer`** (ADR adherence: services-own-DB, effects-in-procedure, avatar-pattern reuse, ADR-0005 forms, optimistic-vs-pessimistic) **and `/security-review`** (this slice touches the upload ownership check + author-or-admin edit/delete boundary). Then `pnpm i18n:compile && pnpm check:ci && pnpm build && pnpm test:node`, plus the **live browser walkthrough** in Task 12 (the editor/map can't run in the browser-mode harness — no `RouterProvider`, MapLibre needs WebGL; see `test/browser/README.md`).

---

## Task 1: Dependencies + extract the HEIC helpers

Extract the two HEIC helpers from `AvatarUpload.tsx` into a shared module so the photo uploader reuses them (DRY). This is a **behavior-preserving refactor** — `AvatarUpload` must keep working unchanged. Add the two new deps in the same task.

**Files:**
- Create: `src/lib/image/heic.ts`
- Modify: `src/components/user/AvatarUpload.tsx`, `package.json`, `pnpm-lock.yaml`

**Interfaces:**
- Produces: `isHeicCandidate(file: File): boolean`, `transcodeHeicToJpeg(file: File): Promise<File>` from `~/lib/image/heic`; `exifr` + `@dnd-kit/sortable` importable.

- [ ] **Step 1: Add the two dependencies**

Run: `pnpm add exifr @dnd-kit/sortable`
Expected: both added to `dependencies`; `@dnd-kit/utilities` already resolvable (present in the lockfile); lockfile updated.

- [ ] **Step 2: Create the shared HEIC module**

Create `src/lib/image/heic.ts` (move the bodies verbatim from `AvatarUpload.tsx:29–41`):

```ts
// HEIC/HEIF transcode helpers, shared by avatar + recommendation photo uploads.
// iOS shoots HEIC; the upload mint allow-list (UPLOAD_IMAGE_MIME) accepts only
// jpeg/png/webp/avif, so HEIC must be transcoded to JPEG in the browser first.
// `heic-to` is lazy-imported so it never enters the initial bundle.
export function isHeicCandidate(file: File): boolean {
  const t = file.type.toLowerCase()
  if (t === 'image/heic' || t === 'image/heif') return true
  const n = file.name.toLowerCase()
  return n.endsWith('.heic') || n.endsWith('.heif')
}

export async function transcodeHeicToJpeg(file: File): Promise<File> {
  const { heicTo } = await import('heic-to')
  const blob = await heicTo({ blob: file, type: 'image/jpeg', quality: 0.85 })
  const renamed = file.name.replace(/\.(heic|heif)$/i, '.jpg')
  return new File([blob], renamed, { type: 'image/jpeg' })
}
```

- [ ] **Step 3: Re-point `AvatarUpload` at the shared module**

In `src/components/user/AvatarUpload.tsx`: delete the two local functions (`isHeicCandidate`, `transcodeHeicToJpeg`, lines 29–41) and add the import near the top:

```ts
import { isHeicCandidate, transcodeHeicToJpeg } from '~/lib/image/heic'
```

Leave everything else in `AvatarUpload` unchanged.

- [ ] **Step 4: Typecheck + verify avatar still builds**

Run: `pnpm build`
Expected: passes (the extraction is import-only; no behavior change).

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml src/lib/image/heic.ts src/components/user/AvatarUpload.tsx
git commit -m "refactor(image): extract HEIC transcode helpers; add exifr + dnd-kit/sortable"
```

---

## Task 2: `exif.ts` — client-side GPS extraction

**Files:**
- Create: `src/lib/files/exif.ts`

**Interfaces:**
- Produces: `readGpsFromFile(file: File): Promise<{ lat: number; lng: number } | null>`.

> **Verification:** this is a thin try/catch around `exifr.gps`; the wrapper logic is verified **live** in Task 12 (drop a phone photo with GPS → marker prefills; a screenshot → no marker). No unit test — exercising it would require a binary EXIF fixture, and `exifr` itself is tested upstream. Consistent with the slice's "live browser" testing posture (ADR-0012 Build-sequence "Tested by").

- [ ] **Step 1: Write the wrapper**

Create `src/lib/files/exif.ts`. `exifr.gps(file)` resolves to `{ latitude, longitude } | undefined` (confirmed against exifr docs; accepts a `File`/`Blob`, parses JPEG **and** HEIC). Must run on the **original** file before any HEIC transcode.

```ts
import exifr from 'exifr'

// Read GPS coordinates from an image File's EXIF, in the browser, BEFORE any
// HEIC->JPEG transcode (the transcode strips metadata — ADR-0012 §4). exifr.gps()
// is the fast path (latitude/longitude tags only) and accepts a File/Blob directly.
// Returns null on: no GPS block, corrupt/unsupported EXIF, or non-finite values —
// the caller then falls back to manual placement.
export async function readGpsFromFile(file: File): Promise<{ lat: number; lng: number } | null> {
  try {
    const gps = await exifr.gps(file)
    if (
      gps &&
      Number.isFinite(gps.latitude) &&
      Number.isFinite(gps.longitude) &&
      Math.abs(gps.latitude) <= 90 &&
      Math.abs(gps.longitude) <= 180
    ) {
      return { lat: gps.latitude, lng: gps.longitude }
    }
    return null
  } catch {
    return null
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm build`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/lib/files/exif.ts
git commit -m "feat(recommendation): add client-side EXIF GPS reader"
```

---

## Task 3: Service — `updateRecommendation` learns to add/remove photos (TDD)

This is the only backend change and the testable heart of the slice. Today `updateRecommendation` edits title/desc/lat/lng/tags only. Expand it to take the **full desired ordered photo set** as a discriminated array, diff it against the current photos, soft-delete removed `file` rows, insert new ones, and rewrite `sort_order` for the whole order (so drag-reorder is persisted here — no separate `reorderPhotos` call). Reuse the existing error codes; **no new codes**.

**Files:**
- Modify: `src/lib/services/recommendation/recommendation.ts`
- Test: `src/lib/services/recommendation/recommendation.test.ts`

**Interfaces:**
- Consumes: existing `file`, `recommendationPhoto`, `recommendationTag` tables; `MIN_PHOTOS`/`MAX_PHOTOS`; `loadActiveRecommendationInTx` / `assertCanMutate` (already in the file).
- Produces:
  ```ts
  export type UpdatePhoto =
    | { kind: 'existing'; photoId: string }
    | { kind: 'new'; pathname: string; mime: string; sizeBytes: number }
  // UpdateRecommendationInput gains: photos: UpdatePhoto[]
  // updateRecommendation now returns: Promise<{ id: string; newPhotoFileIds: string[] }>
  ```

- [ ] **Step 1: Write the failing tests** (append to `recommendation.test.ts`; a `photoIdsFor(id)` helper already exists at the bottom of the file)

```ts
import { isNull } from 'drizzle-orm' // add to the existing drizzle-orm import if not present

test('updateRecommendation adds a new photo (kept existing + new), preserving order', async () => {
  const authorId = await insertAuthor()
  const { id } = await createRecommendation({
    authorId, title: 'P', lat: 0, lng: 0, tagIds: [], photos: [photo('a')],
  })
  const [existingPhotoId] = await photoIdsFor(id)
  const result = await updateRecommendation({
    id, actorId: authorId, actorRole: 'user', title: 'P', lat: 0, lng: 0, tagIds: [],
    photos: [
      { kind: 'existing', photoId: existingPhotoId },
      { kind: 'new', pathname: 'recommendations/x/new.jpg', mime: 'image/jpeg', sizeBytes: 100 },
    ],
  })
  expect(result.newPhotoFileIds.length).toBe(1)
  const item = await findRecommendation(id)
  expect(item.photos.length).toBe(2)
  expect(item.photos.map((p) => p.sortOrder)).toEqual([0, 1])
  // the kept photo stays first (cover), the new one is appended
  expect(item.photos[0].id).toBe(existingPhotoId)
})

test('updateRecommendation removes a photo and soft-deletes its file', async () => {
  const authorId = await insertAuthor()
  const { id } = await createRecommendation({
    authorId, title: 'P', lat: 0, lng: 0, tagIds: [], photos: [photo('a'), photo('b')],
  })
  const [p0, p1] = await photoIdsFor(id)
  const removedFileId = (
    await db.select({ fileId: recommendationPhoto.fileId }).from(recommendationPhoto).where(eq(recommendationPhoto.id, p1))
  )[0].fileId
  await updateRecommendation({
    id, actorId: authorId, actorRole: 'user', title: 'P', lat: 0, lng: 0, tagIds: [],
    photos: [{ kind: 'existing', photoId: p0 }],
  })
  expect(await photoIdsFor(id)).toEqual([p0]) // join row for p1 gone
  const [f] = await db.select({ deletedAt: file.deletedAt }).from(file).where(eq(file.id, removedFileId))
  expect(f.deletedAt).not.toBeNull()
})

test('updateRecommendation persists a reorder of existing photos', async () => {
  const authorId = await insertAuthor()
  const { id } = await createRecommendation({
    authorId, title: 'P', lat: 0, lng: 0, tagIds: [], photos: [photo('a'), photo('b')],
  })
  const [p0, p1] = await photoIdsFor(id)
  await updateRecommendation({
    id, actorId: authorId, actorRole: 'user', title: 'P', lat: 0, lng: 0, tagIds: [],
    photos: [{ kind: 'existing', photoId: p1 }, { kind: 'existing', photoId: p0 }],
  })
  expect(await photoIdsFor(id)).toEqual([p1, p0])
})

test('updateRecommendation rejects removing all photos with NO_PHOTOS', async () => {
  const authorId = await insertAuthor()
  const { id } = await createRecommendation({
    authorId, title: 'P', lat: 0, lng: 0, tagIds: [], photos: [photo('a')],
  })
  await expect(
    updateRecommendation({ id, actorId: authorId, actorRole: 'user', title: 'P', lat: 0, lng: 0, tagIds: [], photos: [] }),
  ).rejects.toMatchObject({ name: 'RecommendationDomainError', code: 'NO_PHOTOS' })
})

test('updateRecommendation rejects more than MAX_PHOTOS with TOO_MANY_PHOTOS', async () => {
  const authorId = await insertAuthor()
  const { id } = await createRecommendation({
    authorId, title: 'P', lat: 0, lng: 0, tagIds: [], photos: [photo('a')],
  })
  const [existing] = await photoIdsFor(id)
  const photos = [
    { kind: 'existing' as const, photoId: existing },
    ...Array.from({ length: 10 }, (_, i) => ({ kind: 'new' as const, pathname: `recommendations/x/n${i}.jpg`, mime: 'image/jpeg', sizeBytes: 100 })),
  ]
  await expect(
    updateRecommendation({ id, actorId: authorId, actorRole: 'user', title: 'P', lat: 0, lng: 0, tagIds: [], photos }),
  ).rejects.toMatchObject({ name: 'RecommendationDomainError', code: 'TOO_MANY_PHOTOS' })
})

test('updateRecommendation rejects duplicate new pathnames with DUPLICATE_PHOTOS', async () => {
  const authorId = await insertAuthor()
  const { id } = await createRecommendation({
    authorId, title: 'P', lat: 0, lng: 0, tagIds: [], photos: [photo('a')],
  })
  const [existing] = await photoIdsFor(id)
  await expect(
    updateRecommendation({
      id, actorId: authorId, actorRole: 'user', title: 'P', lat: 0, lng: 0, tagIds: [],
      photos: [
        { kind: 'existing', photoId: existing },
        { kind: 'new', pathname: 'recommendations/x/dup.jpg', mime: 'image/jpeg', sizeBytes: 100 },
        { kind: 'new', pathname: 'recommendations/x/dup.jpg', mime: 'image/jpeg', sizeBytes: 100 },
      ],
    }),
  ).rejects.toMatchObject({ name: 'RecommendationDomainError', code: 'DUPLICATE_PHOTOS' })
})

test('updateRecommendation rejects an existing photoId from another place with NOT_FOUND', async () => {
  const authorId = await insertAuthor()
  const { id: idA } = await createRecommendation({ authorId, title: 'A', lat: 0, lng: 0, tagIds: [], photos: [photo('a')] })
  const { id: idB } = await createRecommendation({ authorId, title: 'B', lat: 0, lng: 0, tagIds: [], photos: [photo('b')] })
  const [foreignPhotoId] = await photoIdsFor(idB)
  await expect(
    updateRecommendation({
      id: idA, actorId: authorId, actorRole: 'user', title: 'A', lat: 0, lng: 0, tagIds: [],
      photos: [{ kind: 'existing', photoId: foreignPhotoId }],
    }),
  ).rejects.toMatchObject({ name: 'RecommendationDomainError', code: 'NOT_FOUND' })
})
```

**Also amend the 3 existing `updateRecommendation` tests** (`'lets the author edit and replaces tags'`, `'lets an admin edit someone else's place'`, `'blocks a non-owner non-admin'`) — the signature now requires `photos`. For each, capture the created photo id and pass it through unchanged. Example for the first:

```ts
test('updateRecommendation lets the author edit and replaces tags', async () => {
  const authorId = await insertAuthor()
  const [restaurant, cove, beach] = await tagIds('restaurant', 'cove', 'beach')
  const { id } = await createRecommendation({
    authorId, title: 'Old', lat: 38.7, lng: 20.65, tagIds: [restaurant, cove], photos: [photo('a')],
  })
  const [keep] = await photoIdsFor(id)
  await updateRecommendation({
    id, actorId: authorId, actorRole: 'user', title: 'New', lat: 38.7, lng: 20.65, tagIds: [beach],
    photos: [{ kind: 'existing', photoId: keep }],
  })
  const item = await findRecommendation(id)
  expect(item.title).toBe('New')
  expect(item.tagIds).toEqual([beach])
})
```

Apply the same `const [keep] = await photoIdsFor(id)` + `photos: [{ kind: 'existing', photoId: keep }]` addition to the admin-edit and non-owner-blocked tests (the non-owner test still rejects with `CANNOT_EDIT_OTHERS_RECOMMENDATION` before photos are touched).

- [ ] **Step 2: Run the tests — confirm they fail**

Run: `pnpm test:node -- recommendation`
Expected: FAIL — the new tests reference a `photos` arg / `newPhotoFileIds` the current `updateRecommendation` doesn't accept (type error / `undefined`), and the amended existing tests won't typecheck.

- [ ] **Step 3: Expand the service**

Edit `src/lib/services/recommendation/recommendation.ts`. Add the `UpdatePhoto` type, the `photos` field on `UpdateRecommendationInput`, and rewrite `updateRecommendation`:

```ts
export type UpdatePhoto =
  | { kind: 'existing'; photoId: string }
  | { kind: 'new'; pathname: string; mime: string; sizeBytes: number }

export interface UpdateRecommendationInput {
  id: string
  actorId: string
  actorRole: string | null
  title: string
  description?: string | null
  lat: number
  lng: number
  tagIds: string[]
  photos: UpdatePhoto[] // the full desired ordered set (existing kept by id + new uploads)
}

export async function updateRecommendation(
  input: UpdateRecommendationInput,
): Promise<{ id: string; newPhotoFileIds: string[] }> {
  // Count + duplicate checks mirror createRecommendation (check-first, ADR-0002).
  if (input.photos.length < MIN_PHOTOS) throw new RecommendationDomainError('NO_PHOTOS')
  if (input.photos.length > MAX_PHOTOS) throw new RecommendationDomainError('TOO_MANY_PHOTOS')
  const newPhotos = input.photos.filter((p) => p.kind === 'new') as Extract<UpdatePhoto, { kind: 'new' }>[]
  const newPathnames = newPhotos.map((p) => p.pathname)
  if (new Set(newPathnames).size !== newPathnames.length)
    throw new RecommendationDomainError('DUPLICATE_PHOTOS')
  const existingIds = input.photos.flatMap((p) => (p.kind === 'existing' ? [p.photoId] : []))
  if (new Set(existingIds).size !== existingIds.length)
    throw new RecommendationDomainError('NOT_FOUND') // duplicate existing ref = malformed set

  return db.transaction(async (tx) => {
    const row = await loadActiveRecommendationInTx(tx, input.id)
    assertCanMutate(row, input.actorId, input.actorRole, 'CANNOT_EDIT_OTHERS_RECOMMENDATION')

    await tx
      .update(recommendation)
      .set({
        title: input.title,
        description: input.description ?? null,
        lat: input.lat,
        lng: input.lng,
      })
      .where(eq(recommendation.id, input.id))

    await tx.delete(recommendationTag).where(eq(recommendationTag.recommendationId, input.id))
    if (input.tagIds.length > 0) {
      await tx
        .insert(recommendationTag)
        .values(input.tagIds.map((tagId) => ({ recommendationId: input.id, tagId })))
    }

    // --- photo reconciliation -------------------------------------------------
    const current = await tx
      .select({ id: recommendationPhoto.id, fileId: recommendationPhoto.fileId })
      .from(recommendationPhoto)
      .where(eq(recommendationPhoto.recommendationId, input.id))
    const currentIds = new Set(current.map((p) => p.id))

    // Every kept 'existing' ref must belong to this recommendation (else NOT_FOUND,
    // consistent with reorderPhotos' bad-id-set rule).
    const keptIds = new Set<string>()
    for (const photoId of existingIds) {
      if (!currentIds.has(photoId)) throw new RecommendationDomainError('NOT_FOUND')
      keptIds.add(photoId)
    }

    // Remove dropped photos: delete the join row, soft-delete the file row (no byte
    // delete — mirrors softDeleteRecommendation; a future bin/GC reclaims bytes).
    const removed = current.filter((p) => !keptIds.has(p.id))
    if (removed.length > 0) {
      await tx.delete(recommendationPhoto).where(inArray(recommendationPhoto.id, removed.map((p) => p.id)))
      await tx.update(file).set({ deletedAt: new Date() }).where(inArray(file.id, removed.map((p) => p.fileId)))
    }

    // Insert new photos (file + join, temp sort_order rewritten below).
    const newPhotoFileIds: string[] = []
    const newPhotoIdByPathname = new Map<string, string>()
    for (const p of newPhotos) {
      const [f] = await tx
        .insert(file)
        .values({ ownerId: input.actorId, pathname: p.pathname, mime: p.mime, sizeBytes: p.sizeBytes, access: 'public' })
        .returning({ id: file.id })
      const [rp] = await tx
        .insert(recommendationPhoto)
        .values({ recommendationId: input.id, fileId: f.id, sortOrder: 0 })
        .returning({ id: recommendationPhoto.id })
      newPhotoFileIds.push(f.id)
      newPhotoIdByPathname.set(p.pathname, rp.id)
    }

    // Rewrite sort_order across the full desired order (sort_order is not uniquely
    // constrained, so a plain rewrite is safe — ADR-0012 schema notes).
    for (const [index, p] of input.photos.entries()) {
      const photoId = p.kind === 'existing' ? p.photoId : (newPhotoIdByPathname.get(p.pathname) as string)
      await tx.update(recommendationPhoto).set({ sortOrder: index }).where(eq(recommendationPhoto.id, photoId))
    }

    return { id: input.id, newPhotoFileIds }
  })
}
```

(`eq`, `inArray`, `isNull` are already imported in this file; `file`, `recommendation`, `recommendationPhoto`, `recommendationTag` too.)

- [ ] **Step 4: Run the tests — confirm green**

Run: `pnpm test:node -- recommendation`
Expected: PASS — all new photo-edit tests + the amended existing ones + the untouched create/reorder/softDelete tests.

- [ ] **Step 5: Run the `test-completeness` agent**

Confirm every `RecommendationDomainError.code` reachable from `updateRecommendation` is exercised (`NO_PHOTOS`, `TOO_MANY_PHOTOS`, `DUPLICATE_PHOTOS`, `NOT_FOUND`, `CANNOT_EDIT_OTHERS_RECOMMENDATION`). No new codes → no `recommendationErrorMessage.ts` change.

- [ ] **Step 6: Commit**

```bash
git add src/lib/services/recommendation/recommendation.ts src/lib/services/recommendation/recommendation.test.ts
git commit -m "feat(recommendation): support adding/removing/reordering photos in update"
```

---

## Task 4: Procedure — expand the `update` input + handler

Mirror the `create` procedure's per-photo verification for the **new** photos in an `update`: ownership-check the pathname prefix, `storage.head` to resolve the real mime, then call the expanded service and enqueue blurhash for the new files.

**Files:**
- Modify: `src/lib/orpc/procedures/recommendation.ts`

**Interfaces:**
- Consumes: the expanded `updateRecommendation` (`photos: UpdatePhoto[]` → `{ id, newPhotoFileIds }`); existing `photoInput`, `MAX_PHOTO_BYTES`, `SHARP_DECODABLE_MIME_SET`, `stripEnvPrefix`, `storage`, `queue`, `realtime`.
- Produces (client-visible): `recommendation.update` now accepts `photos: ({kind:'existing',photoId} | {kind:'new',pathname,sizeBytes})[]`.

- [ ] **Step 1: Replace the `update` procedure**

In `src/lib/orpc/procedures/recommendation.ts`, add a discriminated photo schema near `photoInput`:

```ts
const updatePhotoInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('existing'), photoId: z.string().uuid() }),
  z.object({
    kind: z.literal('new'),
    pathname: z.string().min(1).max(512),
    sizeBytes: z.number().int().positive().max(MAX_PHOTO_BYTES),
  }),
])
```

Replace the whole `update:` procedure with:

```ts
  update: protectedProcedure
    .errors({
      ...recommendationErrors,
      INVALID_PATH: { status: 403 },
      FILE_NOT_IN_STORAGE: { status: 404 },
    })
    .input(
      z.object({
        id: z.string().uuid(),
        title: z.string().min(1).max(255),
        description: z.string().max(2000).optional(),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        tagIds: z.array(z.string().uuid()).max(20),
        photos: z.array(updatePhotoInput).min(MIN_PHOTOS).max(MAX_PHOTOS),
      }),
    )
    .handler(async ({ input, context, errors }) => {
      const prefix = `recommendations/${context.user.id}/`
      // Verify only the NEW photos' blobs (existing ones are already owned rows).
      // Same cheap-prefix-check-then-parallel-head shape as `create`.
      const newInputs = input.photos.filter((p) => p.kind === 'new') as Extract<
        (typeof input.photos)[number],
        { kind: 'new' }
      >[]
      for (const p of newInputs) {
        if (!stripEnvPrefix(p.pathname).startsWith(prefix)) throw errors.INVALID_PATH()
      }
      const verifiedNew = await Promise.all(
        newInputs.map(async (p) => {
          const blob = await storage.head('public', p.pathname)
          if (!blob) throw errors.FILE_NOT_IN_STORAGE()
          return { pathname: p.pathname, mime: blob.contentType, sizeBytes: p.sizeBytes }
        }),
      )
      const mimeByPathname = new Map(verifiedNew.map((v) => [v.pathname, v.mime]))

      // Preserve the full desired order; resolve new-photo mime from the heads.
      const servicePhotos = input.photos.map((p) =>
        p.kind === 'existing'
          ? { kind: 'existing' as const, photoId: p.photoId }
          : {
              kind: 'new' as const,
              pathname: p.pathname,
              mime: mimeByPathname.get(p.pathname) as string,
              sizeBytes: p.sizeBytes,
            },
      )

      let result: Awaited<ReturnType<typeof updateRecommendation>>
      try {
        result = await updateRecommendation({
          id: input.id,
          actorId: context.user.id,
          actorRole: context.user.role ?? null,
          title: input.title,
          description: input.description,
          lat: input.lat,
          lng: input.lng,
          tagIds: input.tagIds,
          photos: servicePhotos,
        })
      } catch (err) {
        if (err instanceof RecommendationDomainError) throw errors[err.code]()
        throw err
      }

      // newPhotoFileIds align with verifiedNew order (service filters kind:'new' in
      // input order, same subset the procedure built) — gate blurhash by real mime.
      await Promise.all(
        result.newPhotoFileIds
          .filter((_, i) => SHARP_DECODABLE_MIME_SET.has(verifiedNew[i].mime))
          .map((fileId) =>
            queue
              .publish('blurhash', { fileId, kind: 'recommendation' })
              .catch((e) => context.log.warn('blurhash enqueue failed', { error: e })),
          ),
      )
      await realtime.publish(
        { kind: 'recommendation.changed', ids: [result.id] },
        { source: context.user.id },
      )
      return result
    }),
```

- [ ] **Step 2: Typecheck**

Run: `pnpm build`
Expected: passes. `orpc.recommendation.update`'s input type now requires the discriminated `photos` array (this is what the editor submits in Task 9).

- [ ] **Step 3: Commit**

```bash
git add src/lib/orpc/procedures/recommendation.ts
git commit -m "feat(recommendation): accept photo add/remove in the update procedure"
```

> **Verification note:** procedures have no unit-test harness (tests are service-level — Task 3). Correctness here is the typecheck + the Task 12 live walkthrough (edit a place: add/remove/reorder photos, confirm the map/detail update).

---

## Task 5: i18n — editor, fields, validation, actions, toasts

**Files:**
- Modify: `messages/sv.json`, `messages/en.json`

**Interfaces:**
- Produces: the `m.*` functions consumed by Tasks 6–11.

- [ ] **Step 1: Add to `messages/sv.json`** (source of truth, informal "du"; place near the other `recommendation_*` keys)

```json
"meta_recommendation_new_title": "Lägg till plats",
"meta_recommendation_edit_title": "Redigera plats",
"recommendation_new_title": "Lägg till plats",
"recommendation_new_description": "Dela en plats du seglat till — lägg till bilder, en plats på kartan och taggar.",
"recommendation_edit_title": "Redigera plats",
"recommendation_edit_description": "Uppdatera bilder, plats, beskrivning och taggar.",
"recommendation_add_button": "Lägg till plats",
"recommendation_field_title": "Namn",
"recommendation_field_description": "Beskrivning",
"recommendation_field_description_placeholder": "Varför rekommenderar du den här platsen?",
"recommendation_field_photos": "Bilder",
"recommendation_field_location": "Plats",
"recommendation_field_tags": "Taggar",
"recommendation_photos_hint": "Den första bilden blir omslag. Dra för att ändra ordning.",
"recommendation_photo_add": "Lägg till bilder",
"recommendation_photo_remove": "Ta bort bild",
"recommendation_photo_cover": "Omslag",
"recommendation_photo_uploading": "Laddar upp…",
"recommendation_photo_failed": "Uppladdning misslyckades",
"recommendation_photo_too_large": "Bilden är för stor (max 15 MB).",
"recommendation_photo_max": "Du kan lägga till högst 10 bilder.",
"recommendation_photo_heic_failed": "Kunde inte konvertera HEIC-bilden.",
"recommendation_photo_unsupported": "Formatet stöds inte.",
"recommendation_photo_upload_error": "Något gick fel vid uppladdningen.",
"recommendation_location_unset": "Tryck på kartan för att placera platsen.",
"recommendation_location_hint": "Dra nålen för att justera platsen.",
"recommendation_validation_title_required": "Ange ett namn.",
"recommendation_validation_photos_required": "Lägg till minst en bild.",
"recommendation_validation_location_required": "Välj en plats på kartan.",
"recommendation_create_submit": "Spara plats",
"recommendation_edit_submit": "Spara ändringar",
"recommendation_submit_pending": "Sparar…",
"recommendation_save_error": "Det gick inte att spara platsen.",
"recommendation_edit_action": "Redigera",
"recommendation_delete_action": "Ta bort",
"recommendation_delete_confirm_title": "Ta bort platsen?",
"recommendation_delete_confirm_description": "Platsen tas bort från kartan. Det går inte att ångra.",
"recommendation_delete_confirm_action": "Ta bort",
"recommendation_deleted": "Platsen togs bort.",
"recommendation_delete_error": "Det gick inte att ta bort platsen.",
```

- [ ] **Step 2: Add the same keys to `messages/en.json`** (must stay key-complete)

```json
"meta_recommendation_new_title": "Add place",
"meta_recommendation_edit_title": "Edit place",
"recommendation_new_title": "Add place",
"recommendation_new_description": "Share a place you've sailed to — add photos, a spot on the map, and tags.",
"recommendation_edit_title": "Edit place",
"recommendation_edit_description": "Update photos, location, description, and tags.",
"recommendation_add_button": "Add place",
"recommendation_field_title": "Name",
"recommendation_field_description": "Description",
"recommendation_field_description_placeholder": "Why do you recommend this place?",
"recommendation_field_photos": "Photos",
"recommendation_field_location": "Location",
"recommendation_field_tags": "Tags",
"recommendation_photos_hint": "The first photo becomes the cover. Drag to reorder.",
"recommendation_photo_add": "Add photos",
"recommendation_photo_remove": "Remove photo",
"recommendation_photo_cover": "Cover",
"recommendation_photo_uploading": "Uploading…",
"recommendation_photo_failed": "Upload failed",
"recommendation_photo_too_large": "Image is too large (max 15 MB).",
"recommendation_photo_max": "You can add up to 10 photos.",
"recommendation_photo_heic_failed": "Couldn't convert the HEIC image.",
"recommendation_photo_unsupported": "Unsupported format.",
"recommendation_photo_upload_error": "Something went wrong during upload.",
"recommendation_location_unset": "Tap the map to place the spot.",
"recommendation_location_hint": "Drag the pin to adjust the location.",
"recommendation_validation_title_required": "Enter a name.",
"recommendation_validation_photos_required": "Add at least one photo.",
"recommendation_validation_location_required": "Pick a spot on the map.",
"recommendation_create_submit": "Save place",
"recommendation_edit_submit": "Save changes",
"recommendation_submit_pending": "Saving…",
"recommendation_save_error": "Couldn't save the place.",
"recommendation_edit_action": "Edit",
"recommendation_delete_action": "Delete",
"recommendation_delete_confirm_title": "Delete this place?",
"recommendation_delete_confirm_description": "The place will be removed from the map. This can't be undone.",
"recommendation_delete_confirm_action": "Delete",
"recommendation_deleted": "Place deleted.",
"recommendation_delete_error": "Couldn't delete the place.",
```

- [ ] **Step 3: Compile**

Run: `pnpm i18n:compile`
Expected: `src/paraglide/messages` regenerates; all new `m.*` typecheck.

- [ ] **Step 4: Commit**

```bash
git add messages/sv.json messages/en.json src/paraglide
git commit -m "feat(recommendation): add editor i18n strings"
```

---

## Task 6: `mapConfig.ts` + `TagPicker`

De-dupe the MapTiler URL/center (shared by the read map and the picker), and build the simplest UI leaf (tag multi-select).

**Files:**
- Create: `src/components/recommendation/mapConfig.ts`, `src/components/recommendation/TagPicker.tsx`
- Modify: `src/components/recommendation/RecommendationMap.tsx`

**Interfaces:**
- Produces: `LEFKADA`, `mapStyleUrl()` from `./mapConfig`; `<TagPicker value={string[]} onChange={(ids:string[])=>void} />` (value = selected tag **ids**).

- [ ] **Step 1: Extract the shared map config**

Create `src/components/recommendation/mapConfig.ts`:

```ts
// Shared MapLibre config for the read map (RecommendationMap) and the editor's
// LocationPicker. The MapTiler key is client-exposed by nature (the browser fetches
// the style JSON) — not a secret; restricted by HTTP-referrer in the dashboard.
export const LEFKADA = { longitude: 20.65, latitude: 38.7, zoom: 9 } as const

export function mapStyleUrl(): string {
  return `https://api.maptiler.com/maps/satellite/style.json?key=${import.meta.env.VITE_MAPTILER_API_KEY}`
}
```

In `src/components/recommendation/RecommendationMap.tsx`, delete the local `LEFKADA` + `MAP_STYLE` consts (lines 10–11) and import them, using `mapStyle={mapStyleUrl()}`:

```ts
import { LEFKADA, mapStyleUrl } from './mapConfig'
// …
<MapGL ref={mapRef} initialViewState={LEFKADA} mapStyle={mapStyleUrl()} onLoad={fitToPlaces} style={{ width: '100%', height: '100%' }}>
```

- [ ] **Step 2: Write `TagPicker`** (multi-select via the existing `ToggleGroup`, `type="multiple"`; value = tag **ids**, resolved to localized labels through the registry)

Create `src/components/recommendation/TagPicker.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query'
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'
import { orpc } from '~/lib/orpc/client'
import { isTagSlug, tagLabels } from './tagLabels'

// Multi-select over the fixed, seeded tag set. `value`/`onChange` carry tag IDs
// (what create/update want); labels come from tagLabels[slug](). Tags are loaded
// in the route loader, so this query is warm.
export function TagPicker({
  value,
  onChange,
}: {
  value: string[]
  onChange: (ids: string[]) => void
}) {
  const { data: tags } = useQuery(orpc.tag.list.queryOptions())
  return (
    <ToggleGroup
      type="multiple"
      variant="outline"
      value={value}
      onValueChange={onChange}
      className="flex flex-wrap justify-start gap-2"
    >
      {(tags ?? []).map((t) => (
        <ToggleGroupItem key={t.id} value={t.id} className="rounded-full">
          {isTagSlug(t.slug) ? tagLabels[t.slug]() : t.slug}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
```

> Confirm `ToggleGroup` supports `type="multiple"` (Radix's does; the shadcn wrapper forwards it) and that `onValueChange` yields `string[]` for the multiple variant. If the project's `ToggleField` only wires `type="single"`, that's fine — `TagPicker` uses the raw `ToggleGroup`, not the bound field.

- [ ] **Step 3: Typecheck**

Run: `pnpm build`
Expected: passes (TagPicker isn't mounted yet; this only typechecks it + the map de-dupe).

- [ ] **Step 4: Commit**

```bash
git add src/components/recommendation/mapConfig.ts src/components/recommendation/TagPicker.tsx src/components/recommendation/RecommendationMap.tsx
git commit -m "feat(recommendation): add shared map config and tag picker"
```

---

## Task 7: `PhotoUploader` — multi-photo add / remove / drag-reorder

The component that owns photo selection. It is a **controlled** component over a `FormPhoto[]` value (the single source of truth for membership + order — held in the form field, ADR-0005). On add it runs HEIC transcode → EXIF read → `runUploadFlow` per file; per-upload **progress %** and the file-input ref are the only local state (transient presentation, like `AvatarUpload`). Drag-reorder via `@dnd-kit/sortable`; cover = first.

**Files:**
- Create: `src/components/recommendation/recommendationFormTypes.ts`, `src/components/recommendation/PhotoUploader.tsx`

**Interfaces:**
- Produces:
  ```ts
  // recommendationFormTypes.ts
  export type FormPhoto =
    | { kind: 'existing'; photoId: string; url: string; blurhash: string | null }
    | { kind: 'new'; localId: string; pathname?: string; sizeBytes: number; previewUrl: string; status: 'uploading' | 'done' | 'error' }
  export function toCreatePhotos(photos: FormPhoto[]): { pathname: string; sizeBytes: number }[]
  export function toUpdatePhotos(photos: FormPhoto[]): ({ kind: 'existing'; photoId: string } | { kind: 'new'; pathname: string; sizeBytes: number })[]
  export function photosUploading(photos: FormPhoto[]): boolean
  export function photoKey(p: FormPhoto): string
  ```
  ```ts
  // PhotoUploader.tsx
  <PhotoUploader
    value={FormPhoto[]}
    onChange={(next: FormPhoto[]) => void}
    onExifLocation={(loc: { lat: number; lng: number }) => void} // first GPS-bearing photo
  />
  ```

- [ ] **Step 1: Write the form-photo helpers**

Create `src/components/recommendation/recommendationFormTypes.ts`:

```ts
// The editor's photo view-model. The form field holds an ordered FormPhoto[] (the
// single source of truth for membership + order). 'existing' carries display data
// (url/blurhash) read-only; 'new' carries the local preview + upload status. Submit
// maps to the procedure shapes via the helpers below. A new photo has no `pathname`
// until its upload resolves — that's how we know an upload is still in flight.
export type FormPhoto =
  | { kind: 'existing'; photoId: string; url: string; blurhash: string | null }
  | {
      kind: 'new'
      localId: string
      pathname?: string
      sizeBytes: number
      previewUrl: string
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
export function toUpdatePhotos(
  photos: FormPhoto[],
): ({ kind: 'existing'; photoId: string } | { kind: 'new'; pathname: string; sizeBytes: number })[] {
  return photos.flatMap((p) => {
    if (p.kind === 'existing') return [{ kind: 'existing' as const, photoId: p.photoId }]
    return p.pathname ? [{ kind: 'new' as const, pathname: p.pathname, sizeBytes: p.sizeBytes }] : []
  })
}
```

- [ ] **Step 2: Write `PhotoUploader`**

Create `src/components/recommendation/PhotoUploader.tsx`. It uploads on add (avatar byte-path), reads EXIF on the original file before transcoding, and reorders with `@dnd-kit/sortable`.

```tsx
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ImagePlusIcon, XIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '~/components/ui/button'
import { Progress } from '~/components/ui/progress'
import { Spinner } from '~/components/ui/spinner'
import { UPLOAD_IMAGE_MIME } from '~/lib/orpc/imageUpload'
import { runUploadFlow } from '~/lib/effects/storage/clientUpload'
import { readGpsFromFile } from '~/lib/files/exif'
import { isHeicCandidate, transcodeHeicToJpeg } from '~/lib/image/heic'
import { orpc } from '~/lib/orpc/client'
import { useMutation } from '@tanstack/react-query'
import { cn } from '~/lib/utils'
import { m } from '~/paraglide/messages'
import { type FormPhoto, photoKey } from './recommendationFormTypes'

const ACCEPT = 'image/jpeg,image/png,image/webp,image/avif,image/heic,image/heif,.heic,.heif'
const MAX_BYTES = 15_000_000
const DIRECT_MIME = UPLOAD_IMAGE_MIME as readonly string[]

function uid(): string {
  // No crypto.randomUUID dependency needed; uniqueness only within this mount.
  return `p_${Math.random().toString(36).slice(2)}_${performance.now()}`
}

export function PhotoUploader({
  value,
  onChange,
  onExifLocation,
}: {
  value: FormPhoto[]
  onChange: (next: FormPhoto[]) => void
  onExifLocation?: (loc: { lat: number; lng: number }) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  // Transient per-upload progress %, keyed by localId — presentation only, NOT a
  // field value (mirrors AvatarUpload's local `progress`). Reordering/membership
  // live in the form field via `value`/`onChange`.
  const [progress, setProgress] = useState<Record<string, number>>({})
  const mintMutation = useMutation(orpc.recommendation.mintImageUpload.mutationOptions())

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  // `value` is captured per-call below via a ref so concurrent uploads append
  // correctly without stale closures.
  const valueRef = useRef(value)
  valueRef.current = value

  async function addFiles(files: File[]) {
    let exifReported = value.some((p) => p.kind === 'existing') // don't override on edit
    for (const raw of files) {
      if (valueRef.current.length >= 10) {
        toast.error(m.recommendation_photo_max())
        break
      }
      // EXIF on the ORIGINAL file, before transcode (transcode strips metadata).
      if (!exifReported && onExifLocation) {
        const gps = await readGpsFromFile(raw)
        if (gps) {
          onExifLocation(gps)
          exifReported = true
        }
      }

      let file = raw
      if (isHeicCandidate(raw)) {
        try {
          file = await transcodeHeicToJpeg(raw)
        } catch {
          toast.error(m.recommendation_photo_heic_failed())
          continue
        }
      } else if (!DIRECT_MIME.includes(raw.type)) {
        toast.error(m.recommendation_photo_unsupported())
        continue
      }
      if (file.size > MAX_BYTES) {
        toast.error(m.recommendation_photo_too_large())
        continue
      }
      const contentType = file.type
      if (!DIRECT_MIME.includes(contentType)) {
        toast.error(m.recommendation_photo_unsupported())
        continue
      }

      const localId = uid()
      const previewUrl = URL.createObjectURL(file)
      const slot: FormPhoto = { kind: 'new', localId, sizeBytes: file.size, previewUrl, status: 'uploading' }
      onChange([...valueRef.current, slot])

      try {
        let pathname = ''
        await runUploadFlow(file, {
          access: 'public',
          contentType,
          mint: async () => {
            const minted = await mintMutation.mutateAsync({ contentType, sizeBytes: file.size, name: file.name })
            pathname = minted.pathname
            return minted
          },
          confirm: async () => {}, // no confirm step — pathname is submitted with the form
          onProgress: (e) => setProgress((p) => ({ ...p, [localId]: e.percentage })),
        })
        onChange(
          valueRef.current.map((p) =>
            p.kind === 'new' && p.localId === localId ? { ...p, pathname, status: 'done' } : p,
          ),
        )
      } catch {
        toast.error(m.recommendation_photo_upload_error())
        onChange(
          valueRef.current.map((p) =>
            p.kind === 'new' && p.localId === localId ? { ...p, status: 'error' } : p,
          ),
        )
      } finally {
        setProgress((p) => {
          const { [localId]: _drop, ...rest } = p
          return rest
        })
      }
    }
    if (inputRef.current) inputRef.current.value = ''
  }

  function removeAt(key: string) {
    const target = value.find((p) => photoKey(p) === key)
    if (target?.kind === 'new') URL.revokeObjectURL(target.previewUrl)
    onChange(value.filter((p) => photoKey(p) !== key))
  }

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = value.findIndex((p) => photoKey(p) === active.id)
    const to = value.findIndex((p) => photoKey(p) === over.id)
    if (from < 0 || to < 0) return
    onChange(arrayMove(value, from, to))
  }

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        className="sr-only"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length) void addFiles(files)
        }}
      />
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={value.map(photoKey)} strategy={horizontalListSortingStrategy}>
          <div className="flex flex-wrap gap-3">
            {value.map((p, i) => (
              <PhotoTile
                key={photoKey(p)}
                photo={p}
                isCover={i === 0}
                progress={p.kind === 'new' ? progress[p.localId] : undefined}
                onRemove={() => removeAt(photoKey(p))}
              />
            ))}
            <Button
              type="button"
              variant="outline"
              onClick={() => inputRef.current?.click()}
              className="size-24 flex-col gap-1 border-dashed"
            >
              <ImagePlusIcon />
              <span className="text-xs">{m.recommendation_photo_add()}</span>
            </Button>
          </div>
        </SortableContext>
      </DndContext>
      <p className="text-muted-foreground text-xs">{m.recommendation_photos_hint()}</p>
    </div>
  )
}

function PhotoTile({
  photo,
  isCover,
  progress,
  onRemove,
}: {
  photo: FormPhoto
  isCover: boolean
  progress: number | undefined
  onRemove: () => void
}) {
  const id = photoKey(photo)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const src = photo.kind === 'existing' ? photo.url : photo.previewUrl
  const uploading = photo.kind === 'new' && photo.status === 'uploading'
  const failed = photo.kind === 'new' && photo.status === 'error'
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'relative size-24 overflow-hidden rounded-lg border bg-muted',
        isDragging && 'z-10 opacity-80',
      )}
      {...attributes}
      {...listeners}
    >
      {/* Plain <img> on object-URL/known URL — no transformer needed for a local preview. */}
      <img src={src} alt="" className="size-full object-cover" />
      {isCover ? (
        <span className="absolute top-1 left-1 rounded bg-foreground/70 px-1.5 py-0.5 text-[10px] text-background">
          {m.recommendation_photo_cover()}
        </span>
      ) : null}
      {uploading ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-foreground/40 text-background">
          <Spinner />
          {typeof progress === 'number' ? <Progress value={progress} className="w-16" /> : null}
        </div>
      ) : null}
      {failed ? (
        <div className="absolute inset-0 flex items-center justify-center bg-destructive/70 text-center text-[10px] text-background">
          {m.recommendation_photo_failed()}
        </div>
      ) : null}
      <button
        type="button"
        aria-label={m.recommendation_photo_remove()}
        onClick={onRemove}
        onPointerDown={(e) => e.stopPropagation()} // don't start a drag from the remove button
        className="absolute top-1 right-1 rounded-full bg-foreground/70 p-1 text-background hover:bg-foreground"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  )
}
```

> Library-API checks while wiring (low risk; standard `@dnd-kit/sortable` surface): `useSortable`, `SortableContext`, `arrayMove`, `horizontalListSortingStrategy`, `sortableKeyboardCoordinates`, and `CSS.Transform.toString` are the documented exports. `MintUploadResult` from `runUploadFlow`'s `mint` is captured for `pathname` via the closure (the `confirm` callback is intentionally a no-op — there is no confirm procedure for recommendation photos).

- [ ] **Step 3: Typecheck**

Run: `pnpm build`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add src/components/recommendation/recommendationFormTypes.ts src/components/recommendation/PhotoUploader.tsx
git commit -m "feat(recommendation): add multi-photo uploader with drag-reorder + EXIF"
```

---

## Task 8: `LocationPicker` — client-only mini map with a draggable marker

**Files:**
- Create: `src/components/recommendation/LocationPicker.tsx`

**Interfaces:**
- Produces: **default export** `LocationPicker` (so the editor can `React.lazy` it — client-only, imports `maplibre-gl` CSS), props `{ value: { lat: number; lng: number } | null; onChange: (loc: { lat: number; lng: number }) => void }`.

- [ ] **Step 1: Write the picker**

Create `src/components/recommendation/LocationPicker.tsx`. Tap the map to place when unset; drag the marker to adjust. Centers on `value` if set, else Lefkada.

```tsx
import 'maplibre-gl/dist/maplibre-gl.css'
import {
  Map as MapGL,
  type MapLayerMouseEvent,
  type MarkerDragEvent,
  Marker,
  NavigationControl,
} from '@vis.gl/react-maplibre'
import { MapPinIcon } from 'lucide-react'
import { LEFKADA, mapStyleUrl } from './mapConfig'

export default function LocationPicker({
  value,
  onChange,
}: {
  value: { lat: number; lng: number } | null
  onChange: (loc: { lat: number; lng: number }) => void
}) {
  const initialViewState = value ? { longitude: value.lng, latitude: value.lat, zoom: 11 } : LEFKADA
  return (
    <MapGL
      initialViewState={initialViewState}
      mapStyle={mapStyleUrl()}
      onClick={(e: MapLayerMouseEvent) => onChange({ lat: e.lngLat.lat, lng: e.lngLat.lng })}
      style={{ width: '100%', height: '100%' }}
    >
      <NavigationControl position="top-right" />
      {value ? (
        <Marker
          longitude={value.lng}
          latitude={value.lat}
          anchor="bottom"
          draggable
          onDragEnd={(e: MarkerDragEvent) => onChange({ lat: e.lngLat.lat, lng: e.lngLat.lng })}
        >
          <MapPinIcon className="size-8 fill-brand text-brand drop-shadow" />
        </Marker>
      ) : null}
    </MapGL>
  )
}
```

> Verify the event types/shapes against the installed `@vis.gl/react-maplibre` (`onClick` → `e.lngLat.{lat,lng}`; `Marker` `draggable` + `onDragEnd` → `e.lngLat`). These match `RecommendationMap`'s usage of the same package; adjust names only if an export differs. The `fill-brand` uses the existing `--brand` token (ADR-0015).

- [ ] **Step 2: Typecheck**

Run: `pnpm build`
Expected: passes (not mounted yet — wired in Task 9).

- [ ] **Step 3: Commit**

```bash
git add src/components/recommendation/LocationPicker.tsx
git commit -m "feat(recommendation): add client-only location picker map"
```

---

## Task 9: `RecommendationEditor` — the form

Compose the pickers into one `useAppForm` form, container-agnostic (the routes supply data + page chrome + an `onDone`). Create + edit share it; mode is derived from an optional `recommendationId`. The map is lazy + `ClientOnly` (no SSR). Pessimistic submit (await, navigate on success, toast + stay on error).

**Files:**
- Create: `src/components/recommendation/RecommendationEditor.tsx`

**Interfaces:**
- Consumes: `PhotoUploader`, `LocationPicker` (lazy), `TagPicker`, `recommendationFormTypes` helpers, `orpc.recommendation.create`/`update`.
- Produces:
  ```ts
  <RecommendationEditor
    mode="create"
    onDone={(placeId?: string) => void}
  />
  // or
  <RecommendationEditor
    mode="edit"
    recommendationId={string}
    initial={{ title; description; lat; lng; tagIds: string[]; photos: FormPhoto[] }}
    onDone={(placeId?: string) => void}
  />
  ```

- [ ] **Step 1: Write the editor**

Create `src/components/recommendation/RecommendationEditor.tsx`:

```tsx
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ClientOnly } from '@tanstack/react-router'
import { lazy, Suspense, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { FieldError } from '~/components/ui/field'
import { Label } from '~/components/ui/label'
import { Skeleton } from '~/components/ui/skeleton'
import { Textarea } from '~/components/ui/textarea'
import { useAppForm } from '~/hooks/form'
import { isDefinedError } from '@orpc/client'
import { orpc } from '~/lib/orpc/client'
import { recommendationErrorMessage } from '~/lib/orpc/recommendationErrorMessage'
import { m } from '~/paraglide/messages'
import { PhotoUploader } from './PhotoUploader'
import {
  type FormPhoto,
  photosUploading,
  toCreatePhotos,
  toUpdatePhotos,
} from './recommendationFormTypes'
import { TagPicker } from './TagPicker'

const LocationPicker = lazy(() => import('./LocationPicker'))

type Initial = {
  title: string
  description: string
  lat: number
  lng: number
  tagIds: string[]
  photos: FormPhoto[]
}

type Props =
  | { mode: 'create'; onDone: (placeId?: string) => void }
  | { mode: 'edit'; recommendationId: string; initial: Initial; onDone: (placeId?: string) => void }

const schema = z.object({
  title: z.string().min(1, { error: () => m.recommendation_validation_title_required() }).max(255),
  description: z.string().max(2000),
  location: z
    .object({ lat: z.number(), lng: z.number() })
    .nullable()
    .refine((v) => v !== null, { error: () => m.recommendation_validation_location_required() }),
  tagIds: z.array(z.string()),
  // At least one photo, all uploads finished (no in-flight/failed 'new').
  photos: z
    .array(z.any())
    .refine((ps: FormPhoto[]) => ps.length >= 1, { error: () => m.recommendation_validation_photos_required() })
    .refine((ps: FormPhoto[]) => !photosUploading(ps), { error: () => m.recommendation_photo_uploading() }),
})

export function RecommendationEditor(props: Props) {
  const queryClient = useQueryClient()
  const isEdit = props.mode === 'edit'
  const [saving, setSaving] = useState(false)

  const createMutation = useMutation(orpc.recommendation.create.mutationOptions())
  const updateMutation = useMutation(orpc.recommendation.update.mutationOptions())

  const form = useAppForm({
    defaultValues: isEdit
      ? {
          title: props.initial.title,
          description: props.initial.description,
          location: { lat: props.initial.lat, lng: props.initial.lng } as { lat: number; lng: number } | null,
          tagIds: props.initial.tagIds,
          photos: props.initial.photos,
        }
      : {
          title: '',
          description: '',
          location: null as { lat: number; lng: number } | null,
          tagIds: [] as string[],
          photos: [] as FormPhoto[],
        },
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const loc = value.location as { lat: number; lng: number }
      setSaving(true)
      try {
        if (isEdit) {
          const res = await updateMutation.mutateAsync({
            id: props.recommendationId,
            title: value.title,
            description: value.description || undefined,
            lat: loc.lat,
            lng: loc.lng,
            tagIds: value.tagIds,
            photos: toUpdatePhotos(value.photos),
          })
          await queryClient.invalidateQueries({ queryKey: orpc.recommendation.key() })
          props.onDone(res.id)
        } else {
          const res = await createMutation.mutateAsync({
            title: value.title,
            description: value.description || undefined,
            lat: loc.lat,
            lng: loc.lng,
            tagIds: value.tagIds,
            photos: toCreatePhotos(value.photos),
          })
          await queryClient.invalidateQueries({ queryKey: orpc.recommendation.key() })
          props.onDone(res.id)
        }
      } catch (err) {
        // Stay on the form (don't lose the multi-photo input); map domain codes.
        const msg = isDefinedError(err)
          ? recommendationErrorMessage(err.code as Parameters<typeof recommendationErrorMessage>[0])
          : m.recommendation_save_error()
        toast.error(msg)
      } finally {
        setSaving(false)
      }
    },
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        form.handleSubmit()
      }}
      className="flex flex-col gap-6"
    >
      <form.AppField name="title" children={(field) => <field.TextField label={m.recommendation_field_title()} />} />

      <form.AppField
        name="photos"
        children={(field) => (
          <div className="flex flex-col gap-1.5">
            <Label>{m.recommendation_field_photos()}</Label>
            <PhotoUploader
              value={field.state.value}
              onChange={(next) => field.handleChange(next)}
              onExifLocation={(loc) => {
                // Pre-fill location from the first GPS photo only if not already set
                // (don't override a manual placement or an edit's existing location).
                if (form.getFieldValue('location') == null) form.setFieldValue('location', loc)
              }}
            />
            <FieldError errors={field.state.meta.errors} />
          </div>
        )}
      />

      <form.AppField
        name="location"
        children={(field) => (
          <div className="flex flex-col gap-1.5">
            <Label>{m.recommendation_field_location()}</Label>
            <div className="h-64 overflow-hidden rounded-xl border md:h-80">
              <ClientOnly fallback={<Skeleton className="size-full" />}>
                <Suspense fallback={<Skeleton className="size-full" />}>
                  <LocationPicker value={field.state.value} onChange={(loc) => field.handleChange(loc)} />
                </Suspense>
              </ClientOnly>
            </div>
            <p className="text-muted-foreground text-xs">
              {field.state.value ? m.recommendation_location_hint() : m.recommendation_location_unset()}
            </p>
            <FieldError errors={field.state.meta.errors} />
          </div>
        )}
      />

      <form.AppField
        name="description"
        children={(field) => (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rec-description">{m.recommendation_field_description()}</Label>
            <Textarea
              id="rec-description"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              placeholder={m.recommendation_field_description_placeholder()}
              rows={4}
            />
            <FieldError errors={field.state.meta.errors} />
          </div>
        )}
      />

      <form.AppField
        name="tagIds"
        children={(field) => (
          <div className="flex flex-col gap-1.5">
            <Label>{m.recommendation_field_tags()}</Label>
            <TagPicker value={field.state.value} onChange={(ids) => field.handleChange(ids)} />
          </div>
        )}
      />

      <div className="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <form.AppForm>
          <form.CancelButton onClick={() => props.onDone()}>{m.common_cancel()}</form.CancelButton>
          <form.SubmitButton
            label={isEdit ? m.recommendation_edit_submit() : m.recommendation_create_submit()}
            pendingLabel={m.recommendation_submit_pending()}
          />
        </form.AppForm>
      </div>
    </form>
  )
}
```

> Notes: (1) The `photos` field validator uses `z.array(z.any())` because `FormPhoto` is a UI view-model, not a Zod schema — the two `.refine`s enforce ≥1 photo and no in-flight upload. (2) `form.getFieldValue`/`setFieldValue` are TanStack Form instance methods (verify the exact names against `useAppForm`'s returned API / the `@tanstack/react-form` version pinned in `package.json`; if absent, lift a tiny `locationTouched` flag instead — but prefer the form API). (3) `FieldError`, `Label`, `Textarea` are existing UI primitives; confirm `FieldError` accepts `errors={field.state.meta.errors}` (it does — used by every bound field). (4) `isDefinedError` + `recommendationErrorMessage` reuse slice 1's client error map (no new codes).

- [ ] **Step 2: Typecheck**

Run: `pnpm build`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/components/recommendation/RecommendationEditor.tsx
git commit -m "feat(recommendation): add create/edit editor form"
```

---

## Task 10: Create route `/recommendations/new` + "Add place" entry points

**Files:**
- Create: `src/routes/_authenticated/recommendations.new.tsx`
- Modify: `src/routes/_authenticated/recommendations.tsx`

**Interfaces:**
- Consumes: `RecommendationEditor` (create mode); `orpc.tag.list` (loader warm-up for `TagPicker`).
- Produces: `/recommendations/new` route; an "Add place" CTA on the empty state + a header button on `/recommendations`.

- [ ] **Step 1: Write the create route** (model on `shares.assign.$shareCode.tsx`: `useCanGoBack` back nav, `PageContainer width="prose"`)

Create `src/routes/_authenticated/recommendations.new.tsx`:

```tsx
import { createFileRoute, useCanGoBack, useNavigate, useRouter } from '@tanstack/react-router'
import { ArrowLeftIcon } from 'lucide-react'
import { PageContainer } from '~/components/layout/PageContainer'
import { RecommendationEditor } from '~/components/recommendation/RecommendationEditor'
import { Button } from '~/components/ui/button'
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

export const Route = createFileRoute('/_authenticated/recommendations/new')({
  head: () => ({ meta: seo({ title: m.meta_recommendation_new_title() }) }),
  loader: ({ context: { queryClient } }) => queryClient.ensureQueryData(orpc.tag.list.queryOptions()),
  component: NewRecommendationPage,
})

function NewRecommendationPage() {
  const navigate = useNavigate()
  const router = useRouter()
  const canGoBack = useCanGoBack()
  const goBack = () => (canGoBack ? router.history.back() : navigate({ to: '/recommendations' }))

  return (
    <PageContainer width="prose">
      <Button variant="ghost" size="sm" className="-ml-2 self-start" onClick={goBack}>
        <ArrowLeftIcon />
        {m.common_back()}
      </Button>
      <header className="flex flex-col gap-2">
        <h1 className="font-bold text-2xl tracking-tight text-balance md:text-3xl">
          {m.recommendation_new_title()}
        </h1>
        <p className="text-muted-foreground text-sm">{m.recommendation_new_description()}</p>
      </header>
      <RecommendationEditor
        mode="create"
        onDone={(placeId) =>
          placeId
            ? navigate({ to: '/recommendations', search: { place: placeId } })
            : goBack()
        }
      />
    </PageContainer>
  )
}
```

- [ ] **Step 2: Add the "Add place" entry points to `/recommendations`**

In `src/routes/_authenticated/recommendations.tsx`: add a header action button and an empty-state CTA (ADR-0016: a list zero-state gets one role-gated primary CTA where an obvious next action exists — adding a place is obvious; reads are auth-only, so any owner can create). Import `Link` from `@tanstack/react-router` and `PlusIcon` from `lucide-react`.

In the `Header()` component, add the button:

```tsx
function Header() {
  return (
    <header className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-col gap-2">
        <h1 className="font-bold text-2xl tracking-tight text-balance md:text-3xl">
          {m.recommendations_title()}
        </h1>
        <p className="max-w-2xl text-muted-foreground text-sm">{m.recommendations_description()}</p>
      </div>
      <Button asChild>
        <Link to="/recommendations/new">
          <PlusIcon />
          {m.recommendation_add_button()}
        </Link>
      </Button>
    </header>
  )
}
```

In the empty-state branch, add the CTA inside `<Empty>` (after `EmptyHeader`):

```tsx
<EmptyContent>
  <Button asChild>
    <Link to="/recommendations/new">
      <PlusIcon />
      {m.recommendation_add_button()}
    </Link>
  </Button>
</EmptyContent>
```

(Import `EmptyContent` from `~/components/ui/empty` alongside the existing `Empty*` imports, plus `Button`, `Link`, `PlusIcon`.)

- [ ] **Step 3: Build (regenerates the route tree) + live-check create**

Run: `pnpm build`
Expected: `routeTree.gen.ts` gains `/recommendations/new`; build passes.

Then `pnpm dev` (needs `VITE_MAPTILER_API_KEY` in `.env`): click **Add place** → upload 1–2 photos (try a phone HEIC with GPS → marker pre-fills; a non-GPS image → tap the map to place), set a title, pick tags, Save → lands on `/recommendations?place=<newId>` with the new orb on the map and the detail dialog open. Verify a photo's drag-reorder changes the cover.

- [ ] **Step 4: Commit**

```bash
git add src/routes/_authenticated/recommendations.new.tsx src/routes/_authenticated/recommendations.tsx src/routeTree.gen.ts
git commit -m "feat(recommendation): add create route and add-place entry points"
```

---

## Task 11: Edit route + detail-dialog Edit/Delete actions

**Files:**
- Create: `src/routes/_authenticated/recommendations.$id.edit.tsx`
- Modify: `src/components/recommendation/RecommendationDetailDialog.tsx`

**Interfaces:**
- Consumes: `RecommendationEditor` (edit mode); `orpc.recommendation.get`, `orpc.user.me`; `orpc.recommendation.softDelete`; `optimisticRemove`.
- Produces: `/recommendations/$id/edit` (author-or-admin guarded); Edit (link) + Delete (AlertDialog → softDelete) in the detail dialog, shown only to author-or-admin.

- [ ] **Step 1: Write the edit route** (loader pre-fills the editor from `get`; guards author-or-admin)

Create `src/routes/_authenticated/recommendations.$id.edit.tsx`:

```tsx
import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Navigate, useCanGoBack, useNavigate, useRouter } from '@tanstack/react-router'
import { ArrowLeftIcon } from 'lucide-react'
import { PageContainer } from '~/components/layout/PageContainer'
import { RecommendationEditor } from '~/components/recommendation/RecommendationEditor'
import type { FormPhoto } from '~/components/recommendation/recommendationFormTypes'
import { Button } from '~/components/ui/button'
import { orpc } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { seo } from '~/utils/seo'

export const Route = createFileRoute('/_authenticated/recommendations/$id/edit')({
  head: () => ({ meta: seo({ title: m.meta_recommendation_edit_title() }) }),
  loader: async ({ context: { queryClient }, params }) => {
    await Promise.all([
      queryClient.ensureQueryData(orpc.recommendation.get.queryOptions({ input: { id: params.id } })),
      queryClient.ensureQueryData(orpc.tag.list.queryOptions()),
      queryClient.ensureQueryData(orpc.user.me.queryOptions()),
    ])
  },
  component: EditRecommendationPage,
})

function EditRecommendationPage() {
  const { id } = Route.useParams()
  const navigate = useNavigate()
  const router = useRouter()
  const canGoBack = useCanGoBack()
  const goBack = () => (canGoBack ? router.history.back() : navigate({ to: '/recommendations' }))

  const { data: place } = useSuspenseQuery(orpc.recommendation.get.queryOptions({ input: { id } }))
  const { data: me } = useSuspenseQuery(orpc.user.me.queryOptions())

  // Author-or-admin only; everyone else bounces back to the place on the map.
  const canEdit = me.role === 'admin' || place.authorId === me.id
  if (!canEdit) return <Navigate to="/recommendations" search={{ place: id }} replace />

  const initialPhotos: FormPhoto[] = place.photos.map((p) => ({
    kind: 'existing',
    photoId: p.id,
    url: p.url,
    blurhash: p.blurhash,
  }))

  return (
    <PageContainer width="prose">
      <Button variant="ghost" size="sm" className="-ml-2 self-start" onClick={goBack}>
        <ArrowLeftIcon />
        {m.common_back()}
      </Button>
      <header className="flex flex-col gap-2">
        <h1 className="font-bold text-2xl tracking-tight text-balance md:text-3xl">
          {m.recommendation_edit_title()}
        </h1>
        <p className="text-muted-foreground text-sm">{m.recommendation_edit_description()}</p>
      </header>
      <RecommendationEditor
        mode="edit"
        recommendationId={id}
        initial={{
          title: place.title,
          description: place.description ?? '',
          lat: place.lat,
          lng: place.lng,
          tagIds: place.tagIds,
          photos: initialPhotos,
        }}
        onDone={() => navigate({ to: '/recommendations', search: { place: id } })}
      />
    </PageContainer>
  )
}
```

- [ ] **Step 2: Add Edit + Delete to the detail dialog**

Edit `src/components/recommendation/RecommendationDetailDialog.tsx`. Add the `me` query, an author-or-admin gate, an Edit `Link`, and a Delete `AlertDialog` wired to `softDelete` with optimistic-close (callbacks in `mutationOptions`; `optimisticRemove` from the list; close + clear `?place` — the route's `onOpenChange` already navigates `search:{}`).

Add imports:

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { PencilIcon, Trash2Icon } from 'lucide-react'
import { toast } from 'sonner'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '~/components/ui/alert-dialog'
import { Button } from '~/components/ui/button'
import { optimisticRemove } from '~/lib/orpc/optimistic'
```

Inside the component, after the existing queries:

```tsx
  const queryClient = useQueryClient()
  const { data: me } = useQuery(orpc.user.me.queryOptions())
  const canManage = !!place && !!me && (me.role === 'admin' || place.authorId === me.id)

  const deleteMutation = useMutation(
    orpc.recommendation.softDelete.mutationOptions({
      // Optimistic-close: callbacks live here (survive the dialog unmount), the place
      // drops from the map list instantly, and onSettled re-syncs from the server.
      onMutate: (vars) =>
        optimisticRemove(queryClient, orpc.recommendation.list.queryKey(), (p) => p.id === vars.id),
      onError: () => toast.error(m.recommendation_delete_error()),
      onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.recommendation.key() }),
    }),
  )
```

In the loaded branch (after the tag chips, still inside the place `<div>`), add the action row:

```tsx
            {canManage ? (
              <div className="flex justify-end gap-2 border-t pt-4">
                <Button asChild variant="outline" size="sm">
                  <Link to="/recommendations/$id/edit" params={{ id: place.id }}>
                    <PencilIcon />
                    {m.recommendation_edit_action()}
                  </Link>
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="sm" className="text-destructive">
                      <Trash2Icon />
                      {m.recommendation_delete_action()}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{m.recommendation_delete_confirm_title()}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {m.recommendation_delete_confirm_description()}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => {
                          deleteMutation.mutate({ id: place.id })
                          onOpenChange(false) // optimistic close; clears ?place via the route handler
                        }}
                      >
                        {m.recommendation_delete_confirm_action()}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            ) : null}
```

> The success path shows no toast (the orb vanishing is the confirmation, per the optimistic-close convention); only failure toasts. `orpc.user.me` is already cached app-wide, so the extra query is warm. Confirm the `AlertDialog*` export names against `src/components/ui/alert-dialog.tsx`.

- [ ] **Step 3: Build + live-verify edit/delete**

Run: `pnpm build` (route tree gains `/recommendations/$id/edit`), then `pnpm dev`:
- As the author (or an admin): open a place → **Edit** → add a photo, remove one, drag to change the cover, edit title/tags, move the marker → Save → back on the map with changes reflected (cover orb updated). **Delete** → confirm → orb disappears immediately.
- As a non-author non-admin: the Edit/Delete buttons are absent; hitting `/recommendations/<id>/edit` directly redirects to `/recommendations?place=<id>`; attempting an edit via a forged request returns 403 (`CANNOT_EDIT_OTHERS_RECOMMENDATION`, mapped by the client error map).

- [ ] **Step 4: Commit**

```bash
git add src/routes/_authenticated/recommendations.$id.edit.tsx src/components/recommendation/RecommendationDetailDialog.tsx src/routeTree.gen.ts
git commit -m "feat(recommendation): add edit route and detail-dialog edit/delete actions"
```

---

## Task 12: Wrap-up — review, verification, PR

**Files:** none new — verification + review only.

- [ ] **Step 1: Compile + lint + build + node tests**

```bash
pnpm i18n:compile && pnpm check:ci && pnpm build && pnpm test:node
```
Expected: all clean (`test:node` includes the expanded `recommendation.test.ts`).

- [ ] **Step 2: Review checkpoints**

- **`test-completeness`** (already run after Task 3) — re-confirm every `RecommendationDomainError.code` is exercised; no new codes ⇒ `recommendationErrorMessage.ts` unchanged.
- **`vercel:react-best-practices`** over the new TSX: memoized sortable tiles, no `useState` for field values (only progress %/refs), `ClientOnly`+`lazy` for both maps, `URL.revokeObjectURL` on removed previews, effect hygiene.
- **`code-reviewer`** on the diff: services own DB access; the procedure (not the service) heads/verifies blobs; avatar byte-path reused verbatim; ADR-0005 forms; pessimistic editor submit vs optimistic delete-close; i18n key-complete.
- **`/security-review`**: the upload ownership prefix check on `update` new photos; the author-or-admin gate on edit route + detail actions + service; that a forged `update`/`softDelete` from a non-author is rejected server-side (not just hidden in the UI).

- [ ] **Step 3: Full live walkthrough** (record a short GIF if helpful; needs `VITE_MAPTILER_API_KEY`)

1. **Create** — Add place → multi-photo upload (incl. a HEIC), EXIF pre-fills the marker from the first GPS photo (else manual tap-to-place), drag-reorder sets the cover, title + tags, Save → new orb + detail dialog.
2. **Edit** — author/admin: add/remove/reorder photos, move the marker, change title/desc/tags → Save reflects on the map + detail.
3. **Delete** — confirm → orb vanishes instantly; reappears only if the server call fails (toast).
4. **Permissions** — non-author sees no Edit/Delete; `/recommendations/$id/edit` redirects; forged edit → 403.
5. **Realtime** — a second session sees create/edit/delete without reload (slice-1 wiring).
6. **Responsive** — narrow viewport: photo strip wraps, map picker usable, marker draggable, form column comfortable; bottom-sheet detail dialog actions reachable.
7. **Errors** — oversized/HEIC-fail/unsupported photo → per-file toast, form survives; submit blocked while an upload is in flight.

- [ ] **Step 4: Open the slice PR**

Squash-merge repo: PR **title** = `feat(recommendation): add create/edit editor (ADR-0012 slice 3)`; PR **body** = the *why* + links to ADR-0012 and this plan + the live-verification checklist. One concern per PR.

---

## Done-when (Slice 3 acceptance)

- [ ] `/recommendations/new` and `/recommendations/$id/edit` render the shared `RecommendationEditor` on dedicated `PageContainer width="prose"` routes with back-nav.
- [ ] Creating a place uploads ≥1 photo (HEIC transcoded), reads EXIF GPS from the first GPS-bearing **original** (pre-fills the marker; manual tap-to-place otherwise), supports drag-reorder (cover = first), tag multi-select, and a description; Save creates the place and it appears on the map.
- [ ] Editing (author-or-admin) can add/remove/reorder photos, move the marker, and change title/description/tags; `updateRecommendation` persists the full photo set (removed `file` rows soft-deleted) — covered by service tests for every reachable domain code.
- [ ] Deleting (author-or-admin, in the detail dialog) soft-deletes optimistically and clears `?place`.
- [ ] Non-author non-admin cannot edit/delete: no UI affordance, edit route redirects, server rejects forged mutations (403).
- [ ] Editor submit is **pessimistic** (await → navigate on success; toast + stay on error); delete is **optimistic-close**. Submit is blocked while any upload is in flight.
- [ ] Only `exifr` + `@dnd-kit/sortable` added; **no DB migration**; HEIC helpers extracted and `AvatarUpload` unchanged in behavior.
- [ ] `pnpm i18n:compile && pnpm check:ci && pnpm build && pnpm test:node` green; responsive on mobile/tablet/desktop; all new strings localized in `sv` + `en`.

---

## Self-review notes (author)

**Spec coverage (ADR-0012 Slice 3 row = "dedicated editor route: multi-photo upload + add/remove/reorder + EXIF location picker + tag picker; exif.ts, geo.ts"):**
- Dedicated editor route → Tasks 10 (new) + 11 (edit). Multi-photo upload + add/remove/reorder → Task 7 (`PhotoUploader`, dnd-kit) + Task 3 (backend add/remove) + saved-via-update reorder. EXIF location picker → Task 2 (`exif.ts`) + Task 8 (`LocationPicker`) + Task 9 (wiring first-GPS → marker). Tag picker → Task 6 (`TagPicker`). `exif.ts` → Task 2.
- **`geo.ts` deliberately deferred to Slice 6** (documented under "Decisions baked into this plan") — its only consumer is the nearest-me sort; building it here would be a tested helper with no caller (YAGNI). This is the one intentional deviation from the ADR's Slice-3 helper-grouping.

**Deliberate decisions flagged for the reviewer:**
- **One backend change**, fully TDD'd: `updateRecommendation` gains the desired-photo-set diff (Task 3). No new error codes (reuses NO_PHOTOS/TOO_MANY_PHOTOS/DUPLICATE_PHOTOS/NOT_FOUND/CANNOT_EDIT_OTHERS), so `recommendationErrorMessage.ts` is untouched. Existing `update` tests amended for the new required `photos` arg.
- **Reorder rides `update`** (the form holds the full ordered set); the slice-1 `reorderPhotos` procedure stays but is unused by the editor — one atomic Save.
- **Pessimistic editor submit** (input is expensive to re-enter; `INVALID_PATH`/`FILE_NOT_IN_STORAGE` are possible) vs **optimistic delete-close** — per CLAUDE.md mutation guidance.
- **Field-value vs presentation-state** (ADR-0005): the form field holds the ordered `FormPhoto[]` and the `location`; PhotoUploader's only local state is per-upload progress % + the input ref (transient, like `AvatarUpload.progress`). Called out so the reviewer doesn't misread the local state as a shadowed field value.
- **No migration / no new shadcn component / no `confirmPhotoUpload`** — the backbone already covers the byte-path and tables.

**Type consistency:** `FormPhoto` (single view-model) flows editor ↔ uploader; `toCreatePhotos`/`toUpdatePhotos` map it to the `create`/`update` procedure inputs (the latter the discriminated array Task 4 adds); `updateRecommendation` returns `{ id, newPhotoFileIds }`, whose order aligns with the procedure's `verifiedNew` for the blurhash filter. `LocationPicker` is a **default export** (lazy-loaded). `LEFKADA`/`mapStyleUrl` are the single source for both maps.

**Library-API caveats to verify while implementing (low risk, all noted inline):** `@dnd-kit/sortable` exports (`useSortable`/`SortableContext`/`arrayMove`/`horizontalListSortingStrategy`/`sortableKeyboardCoordinates`/`CSS`); `@vis.gl/react-maplibre` `onClick`/`Marker draggable`/`onDragEnd` event shapes (match `RecommendationMap`); `ToggleGroup type="multiple"` `onValueChange: string[]`; `useAppForm` `getFieldValue`/`setFieldValue` method names; `AlertDialog*`/`Empty*`/`FieldError` export names + props.
