# ADR 0010 — Document Management

- **Status**: Accepted
- **Date**: 2026-06-03
- **Deciders**: Lukas
- **Decision in one line**: Add a 1:1 `document` table over `file` so management concerns (name, folder, thumbnail, search, soft-delete) live separately from the universal byte handle; then layer nested folders (adjacency list + denormalized path), a natural-language pg_trgm search box over a concatenated `folder_path || name` haystack, cascade soft-delete with an admin-only bin, full audit history in two sibling event tables (`document_event` + `folder_event`) joined by `correlation_id`, and per-mime-type thumbnail workers reusing the ADR-0007 queue.

> **Amendment (2026-06-10) — access model is read-everything, write-own.** The 2026-06-10 security audit flagged "any authenticated user can list/search/download any document" as an IDOR. It is not: the document library is the *shared* records of one boat (minutes, manuals, insurance) and every co-owner is meant to read all of it. Reads (list, search, history, thumbnail, download) are gated on authentication only; mutations are owner-or-admin (`CANNOT_EDIT_OTHERS_DOCUMENT` et al.); bin and folder mutations are admin-only. Per-document/per-folder visibility is deliberately out of scope — revisit only if a real "private documents" need appears, at which point Alternative N (RLS) is *not* the answer; add a visibility check in the service reads like every other domain rule.

---

## Context

ADR-0006 wired the byte-path: `effects/storage/` adapters, two-Blob-stores split, three-step upload flow, and a `file` metadata table that keeps the storage layer testable. What it left flat is **document organization**. Today:

- `file.folder` is a `text` column nothing reads. Documents land in a flat list ordered by `uploadedAt`.
- `fileRouter` exposes `mintDocumentUpload`, `confirmDocumentUpload`, `listDocuments`, `deleteDocument` — no rename, no move, no search, no history, no bin.
- Soft-delete works (`deleted_at`), but there's no UI for admins to see or restore deleted rows.
- There's a `blurhash` queue topic for image-mime documents, but no actual *thumbnail* rendering — the column stores the encoded hash, not a rendered image.

Co-owners need a real document module: board-meeting minutes, manuals for the boat, insurance docs, photos. The shape of that need is **organizational**, not transport-related:

- **Nested folders** so a year's worth of meeting minutes don't sit in the same flat list as the engine manual.
- **Natural-language search** because nobody remembers exactly what someone called "Båtbottenmålning 2024 utkast slutgiltig.pdf" — they type "bottenmålning" and expect it to surface.
- **A bin** so an admin can recover from a fat-fingered delete without restoring from a Neon branch.
- **History** so we can answer "who renamed this and when" without grepping logs.
- **Thumbnails** so the document grid is scannable without opening each file.

This is a clean separation from storage transport: nothing in this ADR forces a re-read of `effects/storage/`. The byte-path is unchanged. What we're building is the *management* layer that consumes the storage seam and adds organizational primitives on top.

Two reasons this lands as a new ADR rather than an amendment to 0006:

1. **Deletion test.** If we delete this module, what survives? Storage transport, the avatar flow, the existing flat-document upload/confirm/delete loop — all unaffected. Folders, search, history, bin, thumbnails all reappear at every caller that wants to do anything beyond "list everything in upload-date order". The management module is earning its keep as a separate concern.
2. **Reading 0006 should still mean "how do bytes flow."** Loading it up with folder semantics would dilute that.

---

## Prerequisite: A 1:1 `document` table over `file`

Before the rest of this ADR can land cleanly, the `file` table needs to stop doing two jobs.

### The problem

Today, the `file` table holds both **avatars** (`access='public'`, pathname `avatars/{userId}/{uuid}`) and **documents** (`access='private'`, pathname `documents/{uuid}/{name}`). Its `access` column is the only thing keeping them apart, and the strain shows:

- `file.softDelete` carries a `CANNOT_DELETE_AVATAR_VIA_DOCUMENT_DELETE` guard so a doc-delete call doesn't accidentally kill an avatar.
- `file.listAllDocuments` filters `WHERE access = 'private'` so avatars don't leak.
- `file.replaceAvatarForUser` filters `WHERE access = 'public'` so it doesn't soft-delete documents.
- Every test fixture sets `access` explicitly because the schema can't.

ADR-0010 wants to add `folder_id`, `thumbnail_pathname`, and `search_haystack` to this table — all document-only. With a single table:

- `folder_id = null` would mean *both* "avatar" and "document at root". That's a collision: every "list root documents" query has to remember `AND access='private'`.
- Every new document-only column adds another implicit "for documents only" invariant that the schema can't enforce.
- `services/file/file.ts` grows unbounded as both kinds accumulate concerns.

### The fix

Files **are** the same at the byte layer: same upload flow, same storage seam, same blurhash, same mime/size/uploaded-at handling. The differences between avatars and documents are *organizational* (name, folder, search, thumbnail). The 1:1 table captures that asymmetry without duplicating the byte plumbing:

```
file (universal byte handle — minor edits)
  id              uuid pk
  owner_id        uuid → user.id
  pathname        text unique             — storage key
  mime            text
  size_bytes      integer
  blurhash        text null               — placeholder hash (avatar + image-mime docs)
  access          file_access             — transport discriminator: 'public' | 'private'
  uploaded_at     timestamptz
  deleted_at      timestamptz null        — set when the byte is logically gone (replaced avatar; bin hard-delete)
  -- DROPPED: name, folder

document (1:1 with file via file_id — new)
  id                  uuid pk
  file_id             uuid not null unique → file.id on delete cascade
  name                text not null       — user-facing filename
  folder_id           uuid null → folder.id on delete restrict   — null = root
  thumbnail_pathname  text null           — populated by worker
  search_haystack     text not null       — denormalized folder.path || ' ' || name
  deleted_at          timestamptz null    — document soft-delete; file byte stays until hard-delete
```

**Avatars** keep working unchanged in shape: a `file` row only, `access='public'`, `user.image` points at the storage URL, `replaceAvatarForUser` filters by `access='public' AND owner_id`. They have no `document` row.

**Documents** are a `file` row + a `document` row, inserted in one tx during `confirmDocumentUpload`. Every document query starts `FROM document d JOIN file f ON f.id = d.file_id` — avatars are *structurally excluded*. Document soft-delete touches `document.deleted_at` only; the underlying `file` row stays around so the byte is recoverable from the bin. Hard-delete from the bin removes the storage byte, then DELETEs the `file` row (which cascades to `document`).

### Why this is the right shape (vs. alternatives)

- **vs. single table with a `kind` enum**: same bloat as today, the discriminator just gets a different name. The collision moves but doesn't disappear, and the file service keeps both kinds' concerns.
- **vs. full split (separate `avatar` + `document` tables, no `file`)**: duplicates the byte plumbing — two `pathname` columns, two `blurhash` columns, two upload paths, two storage call sites. Heavy-handed for a difference that's only at the management layer.
- **vs. 1:1 (chosen)**: keeps "files are the same at the byte layer" as a structural property. Adds one focused table for management. Avatars don't pay the document tax; documents don't pay the avatar tax. Future kinds (e.g. contact attachments) layer on as more 1:1 tables on `file`.

### Why this is a deep module

The `document` table is itself a deep module:

- **Small interface**: one FK to a file + the management metadata.
- **High leverage**: avatars stay flat; documents get folders, search, thumbnails, history, bin; future kinds slot in without disturbing either.
- **Hidden invariants**: `file_id` is unique (1:1 is enforced), document soft-delete doesn't touch the byte, hard-delete cascades correctly.
- **Test surface = the interface**: `documentService.confirmUpload` writes both rows in one tx, so test fixtures don't need to know about the file layer.

The `CANNOT_DELETE_AVATAR_VIA_DOCUMENT_DELETE` guard goes away entirely: `documentService.softDelete(documentId)` takes a `document.id`. Avatars don't have one. The call is type-prevented from reaching them.

### Migration sequencing

Two migrations, in order:

1. **`drizzle/0010_add_document_table.sql`** (custom, hand-edited — drizzle-kit can't generate the backfill): creates `document` (with `folder_id` as a no-FK column for now), backfills from `file` rows where `access='private'`, drops `file.name` + `file.folder`. Zero rows in prod today; backfill preserves `file.id` so storage pathnames remain valid.
2. **`drizzle/0011_document_management.sql`**: creates `folder`, `file_event`, `folder_event`, `pg_trgm` extension, GIN indexes; ALTERs `document` to add the FK from `folder_id` to `folder(id)`.

Each migration is self-contained and reviewable on its own. The split happens first because everything downstream in this ADR is written against the `document` table.

---

## Decision (TL;DR)

**A document-management layer with seven load-bearing pieces:**

1. **Files split 1:1**: the `file` table is the byte handle (avatars + documents share it); the new `document` table holds management concerns and is 1:1 with `file`. Avatars stay on `file` alone; documents are a `file` row + a `document` row.

2. **Tree model = adjacency list + denormalized path.** A new `folder` table with `parent_id` (null = root) and a `path` text column (`/Manuals/Engine/`) kept transactionally in sync on rename/move. Recursive CTEs are avoided in hot paths; bulk descendant work is one `WHERE path LIKE '<old>/%'` update.

3. **Two sibling event tables.** `document_event` and `folder_event` are separate (polymorphic FKs lose referential integrity). Both carry an optional `correlation_id uuid` so a cascade-delete groups in the bin and history views as **one admin decision**. `from_value` / `to_value` are `jsonb` to keep the schema stable across event kinds.

4. **Permissions are procedure-level**, mapped to existing ADR-0002 patterns:
   - Folder *create* → `protectedProcedure` (any signed-in user).
   - Folder *rename / move / soft-delete / restore* → `adminProcedure`.
   - Document *rename / move / soft-delete* → `protectedProcedure` with service-level `CANNOT_EDIT_OTHERS_DOCUMENT`; admin bypass via role check (same shape as today's `file.softDelete`, lifted to `documentService.softDelete`).
   - Bin view + restore + hard-delete → `adminProcedure`.
   - Read of any non-deleted document → `protectedProcedure`.

5. **Cascade soft-delete is transactional**. `folderService.softDeleteAsAdmin(folderId)` opens one tx, finds the subtree by `path LIKE`, soft-deletes folders + contained documents, emits matched `folder_event` + `document_event` rows under a single `correlation_id`. Restore is the inverse on the same id. Hard-delete (admin from the bin) issues `storage.delete` for each `file.pathname`, then `DELETE` on the `file` row (which cascades to `document`).

6. **Search is a single natural-language input.** Users type words ("bottenmålning", "manual main engine", "möte mars"); they never type paths or wildcards. The implementation builds a concatenated haystack `folder_path || ' ' || name` per document (and `path || ' ' || name` per folder), trigram-indexes it via pg_trgm, and ranks results by `word_similarity(query, haystack)`. Multi-word queries match in any order because trigrams decompose. One oRPC procedure `documentSearchRouter.search({ q })` returns a discriminated union of `{ kind: 'document' | 'folder', id, name, path, score }` sorted by score (document hits additionally carry `mime` + `extension` so the palette can render file-type icons — Amendment 2).

7. **Thumbnails are a separate WebP asset, never an in-place rewrite.** Two topics: `image_thumbnail` (sharp, all `image/*` mimes — bandwidth optimization for grid tiles, not a rendering necessity) and `pdf_thumbnail` (pdfjs/pdf-to-img). Both write to `oceanview-public` at `thumbnails/{documentId}.webp`, update `document.thumbnail_pathname`, and publish `document.changed`. The **original byte at `file.pathname` is never touched**. The PDF worker's heavier deps stay out of the image cold-start path. Thumbnails are best-effort — failure logs but doesn't fail the upload confirm. Existing `blurhash` topic is unchanged; it remains the inline placeholder hash for `<img>` while the thumbnail is the actual rendered preview asset.

8. **No mime whitelist on upload.** Any `contentType` is accepted. Documents without a worker-supported mime (anything other than `image/*` or `application/pdf`) render a mime-type icon in the grid; download still works. A future blacklist can guard against specific dangerous mimes if real examples surface.

The 100MB size cap lives at the procedure layer (Zod). Bulk upload + drag-and-drop are UI-only — they re-run the existing three-step flow N times [shipped sequential, not parallel — see Amendment 2].

---

## Alternatives considered

### A. Table organization — single `file` table with an enum (rejected)
- ➕ Smallest schema diff; no new table.
- ➖ Discriminator collision survives (`folder_id = null` still ambiguous); just renames `access` to `kind`. Every document query keeps the implicit `WHERE kind='document'` filter.
- ➖ `file/file.ts` keeps growing as both avatar and document concerns accumulate.
- ➖ Document-only columns (folder_id, thumbnail_pathname, search_haystack) pile up on a row that doesn't always use them — avatars carry NULLs they can't ever populate.
- **Verdict**: changes the name on the wall without removing the strain.

### B. Table organization — full split into `avatar` + `document`, no shared `file` (rejected)
- ➕ Maximally clean: two narrow tables, no shared base.
- ➖ Duplicates the byte plumbing: two pathname columns, two blurhash columns, two upload-confirm paths, two storage call sites.
- ➖ Future kinds (e.g. contact attachments) duplicate the byte plumbing a third time.
- ➖ Loses the structural property "files are the same at the byte layer", which is true and worth honouring in the schema.
- **Verdict**: heavy-handed for an asymmetry that's only at the management layer.

### C. Table organization — 1:1 `document` over `file` (chosen)
- ➕ Keeps "files are the same at the byte layer" as a real structural property.
- ➕ Avatars don't pay the document tax; documents don't pay the avatar tax.
- ➕ Future file kinds (e.g. `attachment`) extend by adding a sibling 1:1 table.
- ➕ The `CANNOT_DELETE_AVATAR_VIA_DOCUMENT_DELETE` guard disappears entirely (type-prevented).
- ➖ Every document query is a JOIN. Trivially fast at our scale; indexed on both sides.
- ➖ One extra row to insert on document upload (same tx, same connection — invisible cost).
- **Verdict**: the right shape.

### D. Tree model — ltree (rejected)
- ➕ Native Postgres extension, GiST indexes on subtrees, ancestor checks via `@>` operator.
- ➖ ltree labels must match `[A-Za-z0-9_]+`. User-named folders contain spaces, Swedish characters, slashes — every write needs an encoding pass, every read a decoding pass. The breadcrumb display you want round-trips human strings, which ltree labels mangle without an extra layer.
- ➖ Move semantics are operator-elegant (`UPDATE folder SET path = new_root || subpath(path, nlevel(old_root))`) but only if labels survive — see above.
- **Verdict**: would be the right call at 1000+ folders with stable label conventions. At our scale + with user-typed folder names, the denormalized-path approach is simpler and faster to ship.

### E. Tree model — closure table (rejected)
- ➕ Subtree queries are O(rows-in-subtree) lookups, no string matching.
- ➖ Every move/insert writes O(depth) rows. For 10–20 users and a hundred-ish folders this is invisible cost, but the schema doubles (`folder` + `folder_path`) and every service mutation has to maintain both.
- **Verdict**: over-engineered for the workload. The denormalized-path approach is simpler to reason about and well within our scale.

### F. Event model — one polymorphic table (rejected)
- ➕ One table, one query, no `UNION ALL` for cross-entity history.
- ➖ Polymorphic FK (`entity_type text`, `entity_id uuid`) loses referential integrity. Postgres has no way to enforce that `entity_id` points at a real row of the matching kind. Eventual orphan rows.
- ➖ The discriminated union of `from_value` / `to_value` shapes becomes harder to type — the entity type and the value shape vary together.
- **Verdict**: rejected; two real FKs win on integrity.

### G. Event model — parent `document_event` + child rows (rejected, but considered)
- This is the `ownership_assignment_event` pattern (ADR-0009): one parent row per admin decision, children link to the parent. Grouping is automatic from the schema.
- ➕ Cascade grouping is structural — no need for a `correlation_id` column or join-by-uuid in the query.
- ➖ The vast majority of document events (upload, rename, single-file delete) affect *one* entity. A required-parent row for every single-entity event is dead weight: every history query becomes a join.
- ➖ Three tables (parent + two child kinds) versus two (the chosen shape).
- **Verdict**: rejected because cascade events are the minority. `correlation_id uuid null` recovers the grouping for the case where it matters.

### H. Search — Postgres full-text search (`tsvector` + `tsquery`) (rejected for v1)
- ➕ Stemming, stop words, phrase matching, weighted ranking — purpose-built for FTS.
- ➖ Doesn't fuzzy-match typos. "manuel" doesn't match "manual" without `pg_trgm` anyway.
- ➖ `tsquery` syntax (`&`, `|`, `<->`) leaks into client code unless you wrap it. We don't want users to know that syntax exists.
- ➖ Swedish stemming needs `simple` or a non-default config; not zero-config.
- **Verdict**: pg_trgm matches the actual requirement (typo-tolerant, no syntax). If recall becomes a problem later, layer `tsvector` on top of trigrams and merge the scores. Trigger documented below.

### I. Search — `tsvector` + trigram hybrid (deferred)
- ➕ FTS handles stem matches ("möten" → "möte"); trigram handles typos.
- ➕ Score blending is straightforward (`0.7 * ts_rank + 0.3 * trigram_score`).
- ➖ Two indexes per searchable column, two query plans to keep in line, harder to tune.
- **Verdict**: defer until pg_trgm alone is empirically insufficient. Same revisit trigger as (H).

### J. Search — third-party (Meilisearch, Typesense, Algolia) (rejected)
- ➕ Best-in-class ranking out of the box; instant search UX.
- ➖ Another service to run, another sync pipeline (DB → search index) to maintain consistency on rename/move/delete.
- ➖ Conflicts with the "free tier first, no ops burden" posture in CLAUDE.md at our scale.
- **Verdict**: pg_trgm in Postgres keeps everything in one place. Revisit only if document count crosses 10K+.

### K. Thumbnails — single topic, content-type-dispatch in handler (rejected)
- ➕ One queue subscription, one worker deployment, simpler to operate.
- ➖ PDF rendering pulls in `pdfjs-dist` or a native binding (~MBs). Image-only uploads would pay the cold-start tax even when the worker doesn't need PDF code.
- ➖ Failure modes pollute each other: a flaky PDF dep brings down image thumbnailing too.
- **Verdict**: per-mime-family topics keep deps separated. The shared handler dispatches by topic; deployment story is the same (one worker process, multiple subscriptions) but the dep graph is split.

### L. Thumbnails — Vercel Image Optimization for images, no worker (rejected)
- ➕ Zero worker code for images; on-demand resize at any size; format conversion (AVIF/WebP) free.
- ➖ `/_vercel/image` isn't served by the Vite dev server (ADR-0006 already documents this). Local document grid would render broken or fall back to original URLs.
- ➖ Prod needs Build Output API `images.remotePatterns` allowlisting `*.private.blob.vercel-storage.com` — not currently maintained, and the private store URLs are signed-per-read which complicates remote-pattern matching.
- ➖ VIO works only on images, so PDF/other still need a worker. We'd end up with two thumbnail paths instead of one.
- **Verdict**: rejected for v1, consistent with ADR-0006. The worker generates a small WebP per image (~10–30 KB at 400px) which is the same end result as a VIO request at low size, without the platform-integration tax. Revisit if image volume grows large enough that VIO's on-demand sizing wins over pre-rendered fixed-size thumbnails.

### M. Upload mime whitelist (rejected)
- ➕ Defence against weird/dangerous uploads (executables, scripts).
- ➖ Friction for legitimate uses we didn't anticipate ("I want to share this `.dwg` of the keel layout"); every new useful mime requires a code change + deploy.
- ➖ At trusted-userbase scale (10–20 owners + admins), the wrong shape — a blacklist is more proportional when specific concerns surface.
- **Verdict**: drop the whitelist. Accept any contentType. If a specific mime ever causes harm, add it to a blacklist gate in `mintDocumentUpload`. Trigger documented below.

### N. Permissions — row-level security in Postgres (rejected)
- ➕ Defence-in-depth: even a hand-written query couldn't read another user's deleted file.
- ➖ We don't allow hand-written queries — ADR-0002 forces all DB access through services. RLS would duplicate the gate.
- ➖ RLS requires `SET LOCAL` of the session user per request; we'd need to rework `db/index.ts` and the postgres-js driver wiring.
- **Verdict**: services own permissions; RLS is the wrong layer at this scale.

---

## Architecture

### Schemas

**Edited: `file`** (drop document-only columns; what remains is the byte handle)

```ts
// src/lib/db/schema/file.ts — slimmed
export const file = pgTable(
  'file',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    pathname: text('pathname').notNull().unique(),
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    blurhash: text('blurhash'),
    access: fileAccessEnum('access').notNull(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    // DROPPED: name, folder
  },
  (table) => [
    index('file_owner_id_idx').on(table.ownerId),
    index('file_access_idx').on(table.access),
    check('file_size_bytes_nonneg_check', sql`${table.sizeBytes} >= 0`),
  ],
)
```

**New: `document`** (1:1 with `file`)

```ts
// src/lib/db/schema/document.ts
export const document = pgTable(
  'document',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fileId: uuid('file_id').notNull().unique().references(() => file.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),                                                        // base filename, no extension
    extension: text('extension'),                                                        // null = none; immutable on rename
    folderId: uuid('folder_id').references(() => folder.id, { onDelete: 'restrict' }),  // null = root
    thumbnailPathname: text('thumbnail_pathname'),                                       // null until worker writes
    searchHaystack: text('search_haystack').notNull(),                                   // denormalized: folder.path || ' ' || name + '.' + extension
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('document_folder_id_idx').on(table.folderId),
    index('document_search_haystack_trgm_idx').using('gin', sql`${table.searchHaystack} gin_trgm_ops`),
  ],
)
```

`onDelete: 'restrict'` on `folder_id` is intentional — a folder soft-delete cascades through the service, not through the FK. Hard-deleting a non-empty folder fails at the DB level, surfacing as a programming error rather than silent data loss. The `file_id` unique constraint enforces the 1:1 invariant.

The extension is split into its own column (migration `0012_add_document_extension.sql`) so it stays **immutable on rename**: `confirmUpload` runs `splitExtension(filename)` (`src/utils/filename.ts`), `renameDocument` only touches the base `name`, and the display name is rejoined via `joinFilename` everywhere a document is shown. The full display name (base + extension) is what feeds `search_haystack`, so a search for the extension still matches. The download route passes the display name as `getReadUrl(..., { downloadFilename })`; the S3 dev adapter honors it via `ResponseContentDisposition` (exact UTF-8 name).

**Renaming the stored byte.** Vercel Blob (prod) ignores per-read `downloadFilename` and serves `Content-Disposition: attachment; filename="<pathname basename>"` (basic ASCII form only — no `filename*=UTF-8''`). So that prod downloads track a rename, `renameDocument`'s procedure also **renames the storage object**: it `storage.copy`s the byte to a new basename = `safeFilename(displayName)` (same `{uuid}` dir, so no collision and the extension stays intact), repoints `file.pathname` via `fileService.updatePathname`, then deletes the old object. `safeFilename` transliterates Swedish characters (å→a, ä→a, ö→o) before stripping, so the prod name is readable ASCII. The copy → repoint → delete ordering keeps `file.pathname` pointing at a live object throughout; a storage failure is logged and swallowed (the name rename stays committed, download still works under the old basename) and may leave an orphaned blob — tolerated, as with avatar/hard-delete cleanup. `storage.copy` is storage-to-storage, so bytes never transit a Function (ADR-0006).

**New: `folder`**

```ts
// src/lib/db/schema/folder.ts
export const folder = pgTable(
  'folder',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    parentId: uuid('parent_id').references((): AnyPgColumn => folder.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    path: text('path').notNull(),                          // e.g. '/Manuals/Engine/' (trailing slash, root = '/')
    searchHaystack: text('search_haystack').notNull(),     // denormalized: path || ' ' || name
    createdBy: uuid('created_by').notNull().references(() => user.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('folder_parent_id_idx').on(table.parentId),
    index('folder_path_idx').on(table.path),
    index('folder_search_haystack_trgm_idx').using('gin', sql`${table.searchHaystack} gin_trgm_ops`),
    // NB: shipped with parent_id coalesced to a sentinel uuid, not the plain
    // column shown here — Postgres treats each NULL as distinct, so a plain
    // .on(parentId, name) would silently allow duplicate root-folder names.
    // See Amendment 2 and src/lib/db/schema/folder.ts.
    uniqueIndex('folder_unique_name_per_parent_idx')
      .on(table.parentId, table.name)
      .where(sql`${table.deletedAt} IS NULL`),
    check('folder_name_no_slash_check', sql`position('/' in ${table.name}) = 0`),
    check('folder_path_format_check', sql`${table.path} LIKE '/%' AND ${table.path} LIKE '%/'`),
  ],
)
```

`path` is the deep-module trick: callers never compute it; the service writes it. It exists so descendant queries (`WHERE path LIKE '/Manuals/%'`) avoid recursive CTEs. The unique index gates "two folders named the same in the same parent". The check constraints enforce the format invariants the path bookkeeping depends on.

**New: `document_event` and `folder_event`**

```ts
export const documentEventKindEnum = pgEnum('document_event_kind', [
  'upload', 'rename', 'move', 'soft_delete', 'restore', 'hard_delete',
])

export const documentEvent = pgTable(
  'document_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id').references(() => document.id, { onDelete: 'set null' }),  // null after hard delete
    actorId: uuid('actor_id').references(() => user.id, { onDelete: 'set null' }),
    kind: documentEventKindEnum('kind').notNull(),
    fromValue: jsonb('from_value'),                       // keyed by kind: { name }, { folderId, path }
    toValue: jsonb('to_value'),
    correlationId: uuid('correlation_id'),                // shared with sibling rows in a cascade op
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('document_event_document_id_occurred_at_idx').on(table.documentId, desc(table.occurredAt)),
    index('document_event_actor_id_occurred_at_idx').on(table.actorId, desc(table.occurredAt)),
    index('document_event_correlation_id_idx').on(table.correlationId).where(sql`${table.correlationId} IS NOT NULL`),
  ],
)

// folder_event has the same shape, swap documentId → folderId and use a folder_event_kind enum that also includes 'create'.
```

`from_value` / `to_value` are `jsonb` rather than discriminated columns so we don't migrate every time a new event kind appears. The trade-off: queries that filter by old name (`WHERE from_value->>'name' = ...`) lose typed-column ergonomics, but those queries don't exist in the read paths we care about.

`document_id` and `folder_id` use `ON DELETE SET NULL` so the **history outlives hard-delete**. The bin's `hardDeleteDocument` writes a final `hard_delete` event *before* the DB row goes away, then the cascade nulls the historical references. Admins can still answer "who deleted that document last March" after the row itself is gone.

### Search: schema, indexes, and query

The user types one input. There is no syntax to learn — no `/`, no `*`, no field selectors. The system makes it work.

**The haystack**. A denormalized text column per searchable entity:

- For a document: `'<folder_path> <name>'` — e.g. `'/Manuals/Engine/ oil-change.pdf'`. The folder path provides organizational context as additional trigrams; users who type "engine" find the oil-change PDF without having opened the folder.
- For a folder: `'<path> <name>'` — `'/Manuals/Engine/ Engine'`.

We could compute the haystack at query time (`folder.path || document.name`) but the trigram index needs to live on the actual searched expression. Two options, picked in order of preference:

1. **Denormalized `search_haystack text` column** (chosen) — written by the service on insert/rename/move (and bulk-updated on folder rename via the same `WHERE path LIKE` pass). GIN trigram index on the column directly. Simpler query, fewer joins, write-amplification limited to events that already touch path bookkeeping.
2. **Expression index on `folder.path || document.name`** — no denormalized column, but requires the join in every query and the expression must match exactly for the planner to use the index.

We go with (1). The denormalized column is two extra writes during folder rename (one bulk update for the path; one bulk update for the haystack — same `WHERE`), and a much simpler search query.

**Indexes** are declared on the schema (above) but for clarity:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX document_search_haystack_trgm_idx ON document USING gin (search_haystack gin_trgm_ops);
CREATE INDEX folder_search_haystack_trgm_idx   ON folder   USING gin (search_haystack gin_trgm_ops);
```

**Query shape**. `word_similarity(query, haystack)` is the right pg_trgm operator: it computes the greatest similarity between the query and *any extent* of the target string. This handles multi-word queries naturally — "manual main engine" trigram-matches against `"/Manuals/Engine/ Main turbine.pdf"` because the trigrams from each query word overlap with trigrams in the haystack, regardless of order.

```ts
// documentSearch service — pseudocode (as shipped; see note below)
async function search(rawQuery: string) {
  const q = rawQuery.trim().toLowerCase()   // haystacks are lowercased on write
  if (q.length < 2) return []
  const docRows = await db.execute(sql`
    SELECT d.id, d.name, d.folder_id, word_similarity(${q}, d.search_haystack) AS score
    FROM document d
    WHERE d.deleted_at IS NULL
      AND word_similarity(${q}, d.search_haystack) > 0.2   -- threshold; tune empirically
    ORDER BY score DESC
    LIMIT 30
  `)
  const folderRows = await db.execute(sql`
    SELECT id, name, path, word_similarity(${q}, search_haystack) AS score
    FROM folder
    WHERE deleted_at IS NULL
      AND word_similarity(${q}, search_haystack) > 0.2
    ORDER BY score DESC
    LIMIT 10
  `)
  return mergeAndRank(docRows, folderRows)
}
```

> **Correction.** An earlier revision of this section filtered with `search_haystack <%> ${q} < 0.7` and claimed the `WHERE` clause "uses the GIN index". Both halves were wrong: `<%>` is not a pg_trgm operator (the word-similarity *boolean* operators are `<%` / `%>`; the *distance* operators are `<<->` / `<->>`), and a plain `word_similarity(...) > const` predicate — what actually shipped — is **not** index-backed at all. The shipped query deliberately seq-scans and computes `word_similarity` per row, which is fine at our hundreds-of-rows scale. The GIN trigram indexes exist so the documented upgrade path is query-only: switch the `WHERE` to the indexable `search_haystack <% ${q}` and tune `pg_trgm.word_similarity_threshold` when volume warrants it. See Amendment 2 and `src/lib/services/documentSearch/documentSearch.ts`.

`mergeAndRank` is a stable interleave by score; ties broken by entity kind (folders first when scores are equal — folder hits tend to be more navigationally useful).

**Why this satisfies "fuzzy with letters off"**. pg_trgm matches on three-character overlap. A typo in one character knocks out at most three trigrams from the input; the remaining trigrams still match. `word_similarity` reports the best alignment between the query and any window of the haystack, so the user can type "bottnmlning" and still find "Båtbottenmålning 2024.pdf" with a non-zero score.

### Service layer (`src/lib/services/`)

```
file/
  file.ts               EDIT — slimmed to byte-layer + avatar ops:
                          findById, findActiveById, setBlurhash,
                          replaceAvatarForUser, softDelete (byte-level)
                        DROP — confirmUpload, listAllDocuments (moved to documentService)
                        DROP — CANNOT_DELETE_AVATAR_VIA_DOCUMENT_DELETE guard from softDelete
  errors.ts             EDIT — drop CANNOT_DELETE_AVATAR_VIA_DOCUMENT_DELETE and
                          CANNOT_DELETE_OTHERS_FILE (both now document concerns).
                          May be empty; delete file if so.
  file.test.ts          EDIT — keeps avatar + byte-level tests only

document/
  document.ts           NEW — findActiveById (joined), confirmUpload (tx: file + document),
                          listAllDocuments (joined), softDelete (owner/admin gate),
                          renameDocument, moveDocument, restoreDocument,
                          setThumbnailPathname, recomputeSearchHaystack, searchByIds
  errors.ts             NEW — DocumentDomainError codes:
                          NOT_FOUND, CANNOT_DELETE_OTHERS_DOCUMENT,
                          CANNOT_EDIT_OTHERS_DOCUMENT, FOLDER_NOT_FOUND,
                          FOLDER_DELETED, NOT_DELETED
  document.test.ts      NEW — uses documentService.confirmUpload (writes both rows)
  index.ts              NEW — barrel

folder/
  folder.ts             NEW — createFolder, renameFolderAsAdmin, moveFolderAsAdmin,
                          softDeleteFolderAsAdmin, restoreFolderAsAdmin,
                          findFolderById, findActiveFolderById, listChildren,
                          listDescendants, listBin
  errors.ts             NEW — FolderDomainError codes:
                          NOT_FOUND, NAME_TAKEN_IN_PARENT, INVALID_NAME,
                          CANNOT_MOVE_INTO_DESCENDANT, ALREADY_DELETED,
                          NOT_DELETED, NOT_ADMIN
  folder.test.ts        NEW
  index.ts              NEW — barrel

documentSearch/
  documentSearch.ts     NEW — search(q): runs two trigram queries, merges + ranks
  documentSearch.test.ts
  index.ts              NEW — barrel
```

`folder.softDeleteFolderAsAdmin` is the central piece of complexity hidden behind a small interface:

```ts
softDeleteFolderAsAdmin({ folderId, actorId, actorRole }): Promise<{ correlationId; foldersAffected; documentsAffected }>
```

Internally one tx:
1. Load the target folder; reject if `actorRole !== 'admin'` (`NOT_ADMIN`).
2. Compute the subtree: `SELECT id, path FROM folder WHERE id = $1 OR path LIKE $1.path || '%'`.
3. `UPDATE folder SET deleted_at = now() WHERE id = ANY($subtreeIds) AND deleted_at IS NULL` returning ids.
4. `UPDATE document SET deleted_at = now() WHERE folder_id = ANY($subtreeIds) AND deleted_at IS NULL` returning ids.
5. Insert one `folder_event` row per affected folder + one `document_event` row per affected document, all sharing a single `correlation_id` UUID.
6. Return the correlation id + counts so the procedure can log and publish realtime events.

Restore is the inverse on the same correlation id (or accepts a folder id and recomputes the subtree).

`folder.renameFolderAsAdmin` and `folder.moveFolderAsAdmin` are the other hot spots. Both must:
1. Compute the new `path` for the target folder.
2. Reject if the new path collides with an existing folder name at the destination parent.
3. Reject if move target is the folder itself or any of its descendants (`CANNOT_MOVE_INTO_DESCENDANT`).
4. Bulk-update `path` for the target + all descendants in one tx.
5. Bulk-update `search_haystack` for the same folders **and** for all documents in those folders in the same tx (`documentService.recomputeSearchHaystack({ folderIds })`).
6. Emit a `folder_event` for the renamed/moved folder.

### Procedure layer (`src/lib/orpc/procedures/`)

```
folder.ts (NEW)
  folderRouter.createFolder         protectedProcedure   { parentId?, name }
  folderRouter.renameFolder         adminProcedure       { id, name }
  folderRouter.moveFolder           adminProcedure       { id, newParentId | null }
  folderRouter.softDeleteFolder     adminProcedure       { id }                    → cascades
  folderRouter.restoreFolder        adminProcedure       { id | correlationId }    → cascades
  folderRouter.listChildren         protectedProcedure   { folderId | null }
  folderRouter.tree                 protectedProcedure   ()                         → flattened paths for tree UI

document.ts (RENAMED from file.ts + EDITED — all document procedures live here)
  documentRouter.mintDocumentUpload      protectedProcedure  contentType is z.string() (no whitelist)
  documentRouter.confirmDocumentUpload   protectedProcedure  contentType is z.string(); accepts { folderId? };
                                                              writes file + document rows in one tx;
                                                              emits document_event { upload };
                                                              dispatches by mime prefix:
                                                                image/*           → image_thumbnail topic
                                                                application/pdf   → pdf_thumbnail topic
                                                                other             → no enqueue
  documentRouter.listDocuments           protectedProcedure  joined query (document + file + user)
  documentRouter.renameDocument          protectedProcedure  { id, name }       owner/admin
  documentRouter.moveDocument            protectedProcedure  { id, folderId? }  owner/admin
  documentRouter.deleteDocument          protectedProcedure  soft-delete; writes document_event { soft_delete }
  documentRouter.restoreDocument         adminProcedure      { id }
  documentRouter.documentHistory         protectedProcedure  { id }              → document_event rows + actor names

documentSearch.ts (NEW)
  documentSearchRouter.search       protectedProcedure   { q }                      → ranked union

documentBin.ts (NEW)
  binRouter.list                    adminProcedure       ()                         → roots-of-deleted-subtrees, grouped by correlationId
  binRouter.hardDeleteDocument      adminProcedure       { id }                     → document_event { hard_delete } first, then storage.delete + DELETE file row (cascades to document)
  binRouter.hardDeleteFolder        adminProcedure       { id }                     → subtree events + storage.delete + DELETE rows
```

The avatar-side `imageRouter` (`src/lib/orpc/procedures/image.ts`) is **unchanged** — it still calls `fileService.replaceAvatarForUser`. The avatar code path doesn't know `document` exists.

The 100 MB size cap moves into the Zod schema on `mintDocumentUpload` / `confirmDocumentUpload`.

### Thumbnail flow

```
confirmDocumentUpload  ──► file row inserted (tx)
                       ──► document row inserted with computed search_haystack (tx)
                       ──► document_event { kind: 'upload', toValue: { name, folderId } }
                       ──► realtime.publish('document.changed', [documentId])
                       ──► dispatch by mime:
                              mime ∈ SHARP_DECODABLE_MIME_SET → queue.publish('image_thumbnail', { documentId })
                              === 'application/pdf'           → queue.publish('pdf_thumbnail', …)  [reserved, see note]
                              else                            → no enqueue; UI renders mime-type icon

worker (shared handler dispatch on topic):
  ['image_thumbnail']  documentService.findActiveById(documentId) → load original via file.pathname (private store)
                       → sharp().resize(400, { fit: 'inside' }).webp({ quality: 75 })
                       → storage.put('public', 'thumbnails/{documentId}.webp', bytes)
                       → documentService.setThumbnailPathname({ documentId, pathname })
  ['pdf_thumbnail']    same shape, but pdfjs renders page 1 → sharp pipeline → put public:thumbnails/{documentId}.webp
  both                 → realtime.publish('document.changed', [documentId])
```

**The thumbnail is a separate asset.** The worker reads the original from the private store and writes a new object to the public store at `thumbnails/{documentId}.webp`. It never `put`s back to the original `file.pathname`. `file.size_bytes`, `file.mime`, and the original byte are immutable post-upload — the image worker is a bandwidth optimization for grid tiles, not a re-encode of what the user uploaded.

Thumbnail generation is **best-effort**. Failure logs (`context.log.warn`) and surfaces the document without a thumbnail in the UI; no retry beyond the queue's built-in backoff. Hard failure (e.g. PDF cannot be rendered, SVG not decodable by sharp) writes a sentinel `thumbnail_pathname = ''` to avoid re-enqueuing on every list query.

> **Note (implementation, 2026-06-04).** The "by mime prefix" framing above (and in the upload-flow diagram earlier) is the *intent*; the **actual gate is stricter**. `src/lib/orpc/procedures/document.ts` enqueues `image_thumbnail` only when the mime is in `SHARP_DECODABLE_MIME_SET` = `['image/png','image/jpeg','image/jpg','image/webp','image/avif']` — the formats the prebuilt `sharp` binary can decode — not for every `image/*` (HEIC, SVG, etc. fall through to the icon, which is what we want anyway). And `pdf_thumbnail` is **reserved, not wired**: no producer publishes it and no handler consumes it yet (PDFs render a mime-type icon) — see [ADR-0007](./0007-background-job-queue-architecture.md). So today only `image_thumbnail` actually fires.

Existing `blurhash` topic is **unchanged**. Blurhash is the inline placeholder hash that ships in the JSON payload (lives on `file`); the thumbnail is the rendered preview asset served from the public store (lives on `document`). Both can coexist — blurhash is the loading skeleton; the thumbnail replaces it once loaded.

The blurhash queue handler's `'document'` branch becomes: take `{ documentId, kind: 'document' }`, call `documentService.findActiveById(documentId)` to get the joined `{ document, file }`, generate the hash, call `fileService.setBlurhash({ fileId: row.file.id, blurhash })`. The `'avatar'` branch is unchanged.

### UI surface

```
src/routes/_authenticated/documents.index.tsx       EDIT — root view (no folder)        [see Amendment 1]
src/routes/_authenticated/documents.$.tsx           NEW  — splat: /documents/<path>      [see Amendment 1]
src/routes/_authenticated/admin/documents.bin.tsx   NEW  — admin-only bin                [see Amendment 2]
src/components/document/                                                                 [superseded — see Amendment 2]
  DocumentTree.tsx          NEW   — left rail; folder hierarchy
  FolderBreadcrumb.tsx      NEW   — top of grid; path navigation
  DocumentGrid.tsx          NEW   — thumbnails + name + uploader + date; sort + filter
  DocumentSearch.tsx        NEW   — debounced search bar; ranked results; navigates on click
  DocumentUpload.tsx        EDIT  — bulk + drag/drop; runs three-step flow in parallel
  DocumentBin.tsx           NEW   — admin: grouped by correlationId; restore / hard-delete
  FolderActions.tsx         NEW   — create here / rename / move / delete (admin guards)
  DocumentHistory.tsx       NEW   — per-doc event timeline
```

> **Note.** The flat component list above (and `DocumentTree`/`DocumentGrid` specifically) is the plan as written; the shipped tree looks different — see Amendment 2 for the `actions/ card/ dialogs/ shared/ table/ upload/ views/` structure that actually landed.

**Tile-image source**: `<img src={document.thumbnailUrl ?? document.originalUrl}>` for `image/*` mimes — if the worker-generated WebP isn't ready yet (or never will be, e.g. an SVG sharp can't decode), the original renders as a fallback. PDFs render the mime-type icon until the worker writes the thumbnail; everything else renders the mime-type icon permanently. Icons come from `lucide-react` (already a dep): `FileText`, `FileImage`, `FileType`, `File`.

The search bar is **one input, no filters**. Hitting it from anywhere in the documents UI surfaces the ranked discriminated union; clicking a document opens its preview (download via existing signed-URL route), clicking a folder navigates into it. No advanced-search disclosure, no filter chips for v1 — the design bet is that ranking does the work.

Bulk upload is the existing flow N times — no new transport [shipped as a sequential queue — see Amendment 2]. Drag-and-drop is `react-dropzone` (or hand-rolled; the API surface is small).

### Why this is a deep module

- **Interface size**: `folderService` has eleven functions, but the load-bearing complexity is concentrated in three (`softDeleteFolderAsAdmin`, `moveFolderAsAdmin`, `renameFolderAsAdmin`). Each hides path bookkeeping, subtree computation, cascade event emission, search-haystack rewrites, and invariant checks behind a small input contract.
- **Hidden invariants**: path format, name uniqueness per parent, "cannot move into your own descendant", "rename does not cascade to file pathnames" (storage pathnames are immutable; the rename only changes `document.name`), search-haystack always reflects the current folder path.
- **Deletion test**: removing `folderService` reproduces every one of those invariants at every caller — six oRPC procedures, two test files, three UI mutation hooks. The service earns its keep.
- **Two real adapters (test surface)**: services are unit-testable through the same schema-per-test harness as today; thumbnail work goes through the existing queue adapter set (vercel-queues / bullmq / devLog) — no new seam needed.

---

## Verification

A reader can confirm the architecture is followed without running anything:

- `grep -rn "db\.\(select\|insert\|update\|delete\)" src/routes src/lib/orpc/procedures` — zero hits. All DB access through services (ADR-0002).
- `grep -rn "from '@vercel/blob" src/` — unchanged from ADR-0006: server SDK only in `effects/storage/adapters/vercelBlob.ts`; client SDK only in the upload components.
- `grep -rn "file\.folder\|file\.name" src/` — zero hits. Those columns are gone from the byte handle.
- `grep -rn "eq(file.access, 'private')" src/lib/services/` — zero hits. Document scoping is `JOIN document`, not a discriminator filter.
- `grep -rn "CANNOT_DELETE_AVATAR_VIA_DOCUMENT_DELETE" src/` — zero hits. Type-prevented.
- `grep -rn "WHERE.*path.*LIKE\|path LIKE" src/lib/services/` — should match only `folder/folder.ts`. Subtree queries are a `folder` service concern.
- `grep -rn "correlation_id\|correlationId" src/lib/services/` — should match in `folder/folder.ts` and `document/document.ts` (cascade writes), `documentEvent/` read helpers, and tests. In procedures it appears only as `restoreFolder`'s `{ correlationId }` input in `orpc/procedures/folder.ts` (Amendment 2 — restore is keyed by correlation id, not folder id). Never in routes.
- `grep -rn "word_similarity\|gin_trgm_ops\|<%>\|<%" src/lib/services/` — should match only `documentSearch/documentSearch.ts` and the migration. Procedures never construct trigram queries directly.
- `grep -rn "queue\.publish('image_thumbnail'\|'pdf_thumbnail')" src/` — should match only the confirm procedure and tests.
- `grep -rn "search_haystack\|searchHaystack" src/` — should match only the schema files (`db/schema/document.ts`, `db/schema/folder.ts`), the `document/`, `folder/`, and `documentSearch/` services (and their tests), and `documentHelpers.test.ts` (folder-tree fixtures). No route or procedure touches the column.
- `grep -rn "DOCUMENT_MIME\b\|z\.enum\(DOCUMENT_MIME\)" src/` — zero hits. No upload mime whitelist exists.
- `grep -rn "thumbnails/" src/` — matches only the worker handlers and `documentService.setThumbnailPathname`. No procedure or component constructs the thumbnail pathname.
- `grep -rn "storage\.put(['\"]private" src/lib/queue/` — zero hits in the thumbnail workers. They write only to the public store; the original byte at `file.pathname` is never overwritten.

Manual smoke tests:

1. **Avatar upload still works** — `/account`, upload an avatar. One `file` row written (`access='public'`); zero `document` rows. `SELECT count(*) FROM document WHERE file_id IN (SELECT id FROM file WHERE access='public')` returns 0.
2. **Folder create + rename + move** — signed-in user creates `Manuals`; admin renames it to `Manualer`; admin moves `Engine` under `Manualer`. Three `folder_event` rows. All descendant documents' `search_haystack` reflects the new paths (verify by searching for the old name → no hits; new name → hits).
3. **Bulk upload** five PDFs by drag-and-drop into `Manualer/Engine`. Five `file` rows + five `document` rows in five txs. Five `document_event` rows of kind `upload`. Thumbnails appear within seconds; before they appear, blurhash placeholders render.
4. **Natural-language search** — type `bottenmlning` (typo, no diacritics) into the search bar. "Båtbottenmålning 2024.pdf" surfaces in the top hits. Type `engine manual` (two words, different order than the filename "Manual for the engine.pdf"). Hit appears.
5. **Cascade soft-delete** — admin deletes the `Manualer/` folder. Folder + subtree + contained documents all soft-delete in one tx. Bin shows one row "Lukas deleted Manualer/ (3 folders, 12 documents)" — grouped by `correlation_id`. The underlying `file` rows are untouched (`file.deleted_at IS NULL` for the soft-deleted documents).
6. **Cascade restore** from the bin — all restored under the same correlation id. Documents become visible in their original folders.
7. **Hard delete from bin** — `document_event` of kind `hard_delete` written first; `storage.delete` for each pathname runs; `file` row DELETEd (cascades to `document`). The history event row survives (its `document_id` becomes null by FK cascade), so admins can still see "X hard-deleted Y on Z".
8. **Non-admin tries `renameFolder`** — gets Swedish `FORBIDDEN`. Non-admin tries to rename someone else's document — gets `CANNOT_EDIT_OTHERS_DOCUMENT`-mapped Swedish error.
9. **History timeline** — open a document; see upload + rename + move events in order, with actor names.
10. **`pnpm test`** — `file.test.ts` covers byte-level + avatar; `document.test.ts` covers the document layer (using `documentService.confirmUpload` which writes both rows); `folder.test.ts` covers tree ops; `documentSearch.test.ts` covers ranking. Worker tests cover both `image_thumbnail` and `pdf_thumbnail` topics against the `devLog` queue adapter; an explicit test asserts the original byte at `file.pathname` is unchanged after the worker runs (read pre and post, `sha256` equal). All pass.
11. **No-mime-whitelist smoke** — upload a `.dwg` (or any unusual mime). Document row is created with `thumbnail_pathname = null`; no thumbnail job is enqueued; the grid renders a `lucide` mime-type icon for the tile; download via `/api/files/download/{documentId}` returns a signed URL and serves the byte.

---

## Files

**New**:
- `src/lib/db/schema/{document.ts, folder.ts, documentEvent.ts}`
- `src/lib/services/document/{document.ts, errors.ts, document.test.ts, index.ts}`
- `src/lib/services/folder/{folder.ts, errors.ts, folder.test.ts, index.ts}`
- `src/lib/services/documentSearch/{documentSearch.ts, documentSearch.test.ts, index.ts}`
- `src/lib/services/documentEvent/{documentEvent.ts, index.ts}` (read-side helpers; writes inlined in folder/document services for tx locality)
- `src/lib/orpc/procedures/folder.ts`
- `src/lib/orpc/procedures/documentSearch.ts`
- `src/lib/orpc/procedures/documentBin.ts`
- `src/routes/_authenticated/admin/documents.bin.tsx` [see Amendment 2]
- `src/components/document/{DocumentTree.tsx, FolderBreadcrumb.tsx, DocumentGrid.tsx, DocumentSearch.tsx, DocumentBin.tsx, FolderActions.tsx, DocumentHistory.tsx}` [shipped structure differs — see Amendment 2]
- `drizzle/0010_add_document_table.sql` — custom backfill migration: creates `document` (folder_id without FK), backfills from `file WHERE access='private'`, drops `file.name` + `file.folder`.
- `drizzle/0011_document_management.sql` — creates `folder`, `document_event`, `folder_event`, pg_trgm extension, GIN indexes; ALTERs `document.folder_id` to add the FK to `folder(id)`. (Plus `drizzle/0012_add_document_extension.sql` — see the extension paragraph under "Schemas".)
- Worker handlers for `image_thumbnail` + `pdf_thumbnail` topics in the existing queue handler module.

**Modified**:
- `src/lib/db/schema/file.ts` — drop `name` and `folder` columns; keep everything else. The byte handle.
- `src/lib/db/schema/index.ts` — re-export `document`, `folder`, `documentEvent`, `folderEvent`.
- `src/lib/services/file/file.ts` — slim down: drop `confirmUpload`, `listAllDocuments`; `softDelete` drops both the avatar guard and the document owner/role gate (the latter moves to `documentService.softDelete`); what remains is byte-level only.
- `src/lib/services/file/errors.ts` — drop `CANNOT_DELETE_AVATAR_VIA_DOCUMENT_DELETE` and `CANNOT_DELETE_OTHERS_FILE`. May be empty — delete the file if so.
- `src/lib/orpc/procedures/file.ts` → **rename to `document.ts`**. All procedures are document-scoped; the rename matches reality. Add `documentRouter.renameDocument`, `moveDocument`, `restoreDocument`, `documentHistory`; `confirmDocumentUpload` accepts `folderId`, writes both rows in one tx, emits `document_event`, dispatches thumbnail job by mime prefix; `deleteDocument` writes a `document_event` row. **Drops the `DOCUMENT_MIME` whitelist** — `contentType` becomes `z.string().min(1).max(255)`. Size cap raises to 100 MB.
- `src/lib/orpc/procedures/image.ts` — **unchanged**.
- `src/lib/orpc/router.ts` — `fileRouter` → `documentRouter`; mount `folderRouter`, `documentSearchRouter`, `binRouter`.
- `src/lib/queue/handlers/blurhash.ts` — `'document'` branch payload changes from `{ fileId }` to `{ documentId }`; calls `documentService.findActiveById` then `fileService.setBlurhash`. `'avatar'` branch unchanged. [Did not happen — payload stayed `{ fileId, kind }`; see Amendment 2.]
- `src/lib/effects/queue.ts` — register topics `image_thumbnail`, `pdf_thumbnail`.
- `src/lib/effects/realtime/types.ts` — `file.changed` becomes `document.changed`; add `folder.changed` (and `bin.changed` — see Amendment 2).
- `src/routes/api/files/download.$id.ts` — `$id` is now a `document.id`; calls `documentService.findActiveById`; drops the `access !== 'private'` guard (documents are always private by construction).
- `src/routes/_authenticated/documents.index.tsx` + `src/routes/_authenticated/documents.$.tsx` — tree-aware routing, bulk upload, search bar (the single `documents.tsx` split per Amendment 1).
- `src/components/document/DocumentUpload.tsx` — bulk + drag-and-drop; oRPC calls move from `orpc.file.*` → `orpc.document.*`.
- `src/components/document/DocumentList.tsx` — replaced by `DocumentGrid.tsx` (or kept as the table-view variant). Imported type changes to `DocumentWithFile` from `~/lib/services/document`.
- `CLAUDE.md` — skill table, code map, decisions made (note "1:1 document/file" pattern, "avatars stay on file alone").

---

## Consequences

**Positive**:
- The `file` table goes back to being a focused byte handle. The avatar/document collision disappears at the schema level.
- The document module becomes navigable. The seam between byte-path and management is clean — neither layer imports the other's primitives, and the JOIN structurally excludes avatars from every document query.
- Search is one input box. No syntax, no filters, no advanced-search disclosure to learn. Typos and word-order don't matter; the user types what they remember.
- History is queryable from the database, not from log scraping. Bin restores survive admin mistakes without involving Neon branches.
- The thumbnail topic split keeps the PDF dep out of the image cold-start path. New mime types (e.g. office docs) can land as a new topic without disturbing existing workers.
- Future file kinds (contact attachments, share documents, audit attachments) extend the schema by adding a sibling 1:1 table on `file` — no avatar or document code touched.

**Negative**:
- Every document query is a JOIN. Trivially fast at our scale; indexed on both sides; but contributors must remember to join.
- Folder rename of an ancestor with N descendants writes N folder rows + N document rows (path + haystack) in one tx. At our scale (hundreds) this is invisible; at 10K+ it'd warrant moving to ltree or accepting recursive CTEs on the read side. Trigger documented below.
- Two event tables means cross-entity history queries are a `UNION ALL`. The read shape is documented in `documentEvent.ts`; not a hot path.
- `from_value` / `to_value` as `jsonb` lose typed-column ergonomics for filtering by old name. Not a use case we have today.
- `search_haystack` is denormalized. The invariant ("haystack always reflects current folder path") is maintained by services; a hand-written `UPDATE folder SET path = ...` would silently break search until the next rename. The verification grep above flags this — but a future contributor has to honour it.
- The 0010 migration drops the existing `file.folder text` column (unused) and `file.name text` column (avatars currently store the original upload filename here, unused). Documented here so a future archeologist doesn't wonder.
- No upload mime whitelist means a user could upload any mime Postgres can store a string for (executables, scripts, archives). At our trusted-userbase scale this is fine; the risk is bounded by storage being private-by-default and download requiring auth. If we later need to reject specific mimes, add a blacklist gate in `mintDocumentUpload` (open question below).

**Revisit triggers**:

1. **Folder count > 5K or depth > 8** in production. Reconsider ltree (with an encoding strategy for labels) or a closure table. Until then, denormalized path stays.
2. **Search recall poor with pg_trgm alone.** Add a `tsvector` column on `document.name` + `folder.name` and blend the score with the trigram score (`0.7 * ts_rank + 0.3 * word_similarity`). Don't introduce a separate search service unless we cross 10K+ documents.
3. **Thumbnail workload outgrows the shared queue.** If image or PDF processing pushes wall-clock past the Vercel function budget on the consumer, move that topic onto a dedicated Vercel Sandbox or a long-running consumer.
4. **A second event kind needs typed columns** for hot-path filtering. Migrate `from_value` / `to_value` to typed columns per kind (or use generated columns over jsonb paths).
5. **Hard-delete-from-bin gains compliance significance** (e.g. GDPR right-to-erasure surfaces as a feature). Add a `purge` event kind that records the deletion fact while scrubbing actor + value details; add tests covering the storage + row + event semantics together.
6. **A third file kind (e.g. contact attachments) arrives.** Validate the 1:1 pattern still feels right — if every new kind needs the same name/folder/search/bin machinery, consider hoisting a shared "managed file" base.

---

## Open questions (resolve during implementation)

- **Search across deleted rows for admins** — should admin search also surface bin contents (with a flag)? Not required by the requirements; leave for a follow-up.
- **Thumbnail regeneration trigger** — admin action to re-run the thumbnail worker for a document (in case the renderer was upgraded). Not required day one; add as a small admin endpoint if needed.
- **Folder-create event** — `folder_event` kind list currently doesn't include `create`. Add for symmetry with `document_event.upload`? Probably yes — answers "who created this folder" symmetrically. Confirm during the schema-write pass. [Resolved: shipped — see Amendment 2.]
- **Avatar history during migration** — `file.name` for avatars (e.g. `IMG_1234.jpg`) is dropped by 0010. It's not rendered anywhere, but if any logging path includes it, the log line goes blank. Audit `grep -rn 'file.name\|name:' src/lib/orpc/procedures/image.ts src/lib/services/file/` during execution.
- **Mime blacklist** — should specific mimes be rejected (e.g. `application/x-msdownload`, `application/x-sh`)? Not required for the trusted internal user base, but easy to add when concrete examples surface. Track but don't implement v1.
- **Thumbnail backfill / re-run** — if the worker fails repeatedly (bad input, sharp/pdfjs rejection) the document permanently lacks a thumbnail. The `thumbnail_pathname = ''` sentinel prevents re-enqueue churn; a manual admin-only re-run endpoint is a natural follow-up.

---

## Amendments

### Amendment 1 — Path-based folder URLs (2026-06-04)

The original design routed folders with an opaque query param: `/documents?folder=<uuid>`. This **supersedes the URL shape only** — readable, hierarchical URLs:

- Root: `/documents` — `documents.index.tsx`.
- Folder: `/documents/Manuals/Engine` — `documents.$.tsx`, a TanStack splat route.

**Why.** The UUID is opaque and ugly in the address bar. It was never a security boundary either — access is gated by the `_authenticated` layout and per-folder service rules, not URL secrecy — so the only thing the UUID bought was unreadability.

**How — zero server/schema change.** This rides entirely on the existing denormalized `folder.path` column (the same column this ADR introduced for subtree queries). The splat (`params._splat`, already URI-decoded) is matched against `folder.path` in the already-cached `folder.tree` — no new query, service, procedure, or migration. Resolution (`resolveFolderBySplat` in `documentHelpers.ts`) runs in **both** the loader and the route component: the loader resolves the splat so `defaultPreload: 'intent'` prefetches *that folder's* document list on hover (an unresolvable splat prefetches root — harmless); the component re-resolves on every render, so a realtime tree refetch after a rename/move re-resolves automatically. Links are built with `folderPathToSplat(folder.path)`; the router percent-encodes each segment (spaces, å/ä/ö). Comparison is NFC-normalized on both ends — `encodeURIComponent`/`decodeURIComponent` are byte-faithful and won't reconcile precomposed vs decomposed diacritics.

**Tradeoff (accepted).** A folder's URL is derived from its path, so renaming/moving a folder changes its URL. A stale URL (bookmark, old tab) no longer matches any `path` → the splat route redirects to root (`/documents`) rather than 404 — the document library's natural empty state. For a single-boat-club user base this is fine; if stable cross-rename links are ever needed, add a short stable id column and resolve on that instead (the splat plumbing stays).

This does **not** reopen the ltree rejection (§ "Tree model — ltree (rejected)"): that was about *internal label storage*, and the internal `path` denormalization is unchanged.

### Amendment 2 (2026-06-10) — as implemented

The ADR shipped across `1e10b94` (folders, search, bin, management UI — 2026-06-04) through `c286b30` (component-tree restructure — 2026-06-09), plus a hardening pass on 2026-06-10. The architecture held: 1:1 `document` over `file`, adjacency list + denormalized path, two sibling event tables with `correlation_id`, pg_trgm haystack search, transactional cascade soft-delete, separate-WebP thumbnails. The deltas:

**UI**

- **The "UI surface" component list was superseded wholesale.** `DocumentTree` and `DocumentGrid` were never built. The shipped tree is `src/components/document/{actions,card,dialogs,shared,table,upload,views}/`. Desktop is an OS-style **table** (`views/DocumentsDesktop` + `table/DocumentTable*`): multi-select, right-click context menu, and dnd-kit drag-and-drop whose drop semantics are planned by the pure `planMixedDrop` helper (`shared/documentHelpers.ts`). Mobile is a Drive-style touch view (`views/DocumentsMobile`: tap to open, long-press to select). `views/DocumentsView` picks between them by pointer type (`useIsCoarsePointer`), which only resolves after mount — so it renders a hydration-safe skeleton on the server and first client paint.
- **Bin route moved under admin**: `/admin/documents/bin` (`src/routes/_authenticated/admin/documents.bin.tsx`), not `/documents/bin` — it's an admin-only surface and the URL says so.
- **Bulk upload is sequential, not "N in parallel".** An app-wide, navigation-persistent queue (`upload/UploadQueueProvider`, mounted in the `_authenticated` layout so it survives in-app navigation) drains files on Pacer's `useAsyncQueuer` with `concurrency: 1` and exponential retry (`maxAttempts: 3`) — one upload in flight so slow connections aren't flooded.
- **Search UI**: 250 ms trailing debounce (Pacer `useDebouncedValue`), a cmdk command palette (`shared/DocumentSearch.tsx`) opened on `Mod+K` via `@tanstack/react-hotkeys`, server-side filtering only (cmdk's client filter disabled). Search hits carry `mime` + `extension` so the palette renders file-type icons.
- **File-type icons**: `fileTypeAppearance` (`shared/documentHelpers.ts`) maps mime with an extension fallback to a family (pdf/word/excel/csv/presentation/archive/text) with **brand colors** (PDF red, Word blue, Excel/CSV green, PowerPoint orange, archive amber) — an explicit, documented exception to the semantic-colors-only rule: file-type colors are recognized iconography, not theme accents.
- **Tile images**: a new lazy per-tile `documentRouter.thumbnail` procedure replaces the body's `thumbnailUrl ?? originalUrl` plan. The grid renders immediately on a blurhash CSS placeholder; each image tile then resolves its rendered WebP's stable public URL (`staleTime: Infinity` — it never expires) only when a real `thumbnailPathname` exists. **Tiles never load the original byte.**

**Search query**

- Shipped as `word_similarity(q, search_haystack) > 0.2` — an **intentional seq scan** at our hundreds-of-rows scale, with the indexable `<%` operator (+ `pg_trgm.word_similarity_threshold`) as the documented query-only upgrade path; the GIN indexes already exist. The body's pseudocode and its `<%>`/"uses the GIN index" claims were wrong and have been corrected in place.
- The haystack is **lowercased on write** (both `document` and `folder` services) and the query is lowercased to match, making pg_trgm hits case-insensitive.

**Realtime**

- A **third event kind `bin.changed`** (no ids) joins `document.changed`/`folder.changed`. Published only by soft-delete / restore / hard-delete mutations; invalidates `orpc.bin`, so unrelated edits leave the admin bin query untouched.
- As of 2026-06-10, `document.changed` also invalidates `orpc.documentSearch` — uploads, renames, and deletes add/rewrite/remove haystacks, so an open search palette must refetch (`folder.changed` did this from the start).
- `document.thumbnail` is **deliberately never invalidated**: public thumbnail URLs are stable, and a newly rendered thumbnail surfaces via the list refetch (new `thumbnailPathname` → the tile's first fetch).

**Procedures & services**

- **`binRouter.hardDeleteFolder` shipped 2026-06-20** (was previously deferred). Service `hardDeleteFolderAsAdmin({ id })` purges the soft-deleted folder and its entire **physical subtree** (descendant folders + every document inside them + their blobs) in one tx, mirroring `hardDeleteDocument`: writes `hard_delete` `folder_event`/`document_event` rows (one shared `correlationId`) before deleting, drops the `file` rows (cascading the `document` rows), then deletes folders **leaf-first** (the `parent_id` `restrict` FK forbids deleting a parent before its children), and returns the blob pathnames for the procedure to delete best-effort after commit. It works on the **subtree (path prefix), not the soft-delete correlationId** — a document binned individually keeps its own correlation id yet still lives inside the folder and its `restrict` FK would otherwise block the delete. The bin UI exposes it on the folder `BatchCard` (root id), alongside Restore.
- `folderRouter.restoreFolder` takes `{ correlationId }` only (not the planned `{ id | correlationId }`); the service fn is `restoreByCorrelationAsAdmin` — a cascade restore is keyed by the admin decision, not a folder id.
- `confirmDocumentUpload` takes **no `contentType`** — the mime is derived server-side from `storage.head()`, so the client can't lie about it. And as of 2026-06-10 the pathname shape check is `stripEnvPrefix(pathname).startsWith('documents/')`: the bare `startsWith` rejected **every** production upload because the vercelBlob adapter env-prefixes pathnames (`prod/documents/…` — see ADR-0006).
- The blurhash payload **stayed `{ fileId, kind }`** (the handler reads via `fileService.findActiveById`); the planned `{ documentId }` change didn't happen — blurhash lives on `file` and never needs the document row. The thumbnail topic payload is `{ documentId }` as planned.
- Error-code unions shifted: `FolderDomainError` is `NOT_FOUND | NOT_ADMIN | NAME_TAKEN_IN_PARENT | INVALID_NAME | PARENT_NOT_FOUND | CANNOT_MOVE_INTO_DESCENDANT | ALREADY_DELETED | NOT_DELETED | PARENT_DELETED` (gains the `PARENT_*` codes; `NOT_DELETED` was re-added 2026-06-20 as the bin-only guard for `hardDeleteFolder`); `DocumentDomainError` adds `NOT_ADMIN` (and keeps `NOT_DELETED`). The bin router reuses the shared **exhaustive** `rethrowDocumentErrorAsORPC` exported from `procedures/document.ts` — no default case, so a new code breaks the build at the mapper.
- `documentService` surface as shipped: `listDocumentsByFolderId` (per-folder, not a global `listAllDocuments`), plus **tx-composable** `cascadeSoftDelete`/`cascadeRestore` that take the caller's transaction so `folderService`'s cascade composes them without a cross-service tx seam. `listAllDocuments` and `searchByIds` were never built.

**Schema & migrations**

- Migrations landed as `drizzle/0010_add_document_table.sql` + `0011_document_management.sql` (+ `0012_add_document_extension.sql`) — the 0007/0008 numbers in the body had been taken by interim migrations. Corrected in place.
- The folder name-uniqueness index **coalesces NULL `parent_id` to a sentinel uuid** — Postgres treats each NULL as distinct, so the body snippet's plain `.on(parentId, name)` would have allowed duplicate root-folder names (snippet annotated; see `src/lib/db/schema/folder.ts`).
- Resolved open question: the **folder-create event shipped** — `'create'` is in `folder_event_kind` and `createFolder` emits it, answering "who created this folder" symmetrically with `document_event.upload`.
