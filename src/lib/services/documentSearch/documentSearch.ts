import { sql } from 'drizzle-orm'
import { db } from '~/lib/db'

export type SearchHit =
  | {
      kind: 'document'
      id: string
      name: string
      path: string | null
      mime: string
      extension: string | null
      score: number
    }
  | { kind: 'folder'; id: string; name: string; path: string; score: number }

// pg_trgm word_similarity is computed against an already-lowercased haystack
// (see document/folder services), so we lower the query input too. Threshold
// 0.2 is permissive enough for typo-tolerant matches at our scale.
//
// NOTE: `word_similarity(q, col) > const` is NOT index-backed — only the `<%` /
// `<%>` operators can use the GIN trigram index. This query therefore seq-scans
// and computes word_similarity per row, which is fine at our hundreds-of-rows
// scale. The documented upgrade path (ADR-0010) is to switch the WHERE to the
// indexable `col <% q` operator and tune `pg_trgm.word_similarity_threshold`
// when volume warrants it. The GIN indexes on search_haystack already exist so
// that switch is query-only, no migration.
const SCORE_THRESHOLD = 0.2
const DOCUMENT_LIMIT = 30
const FOLDER_LIMIT = 10
const MIN_QUERY_LENGTH = 2

type DocumentSearchRow = {
  id: string
  name: string
  folder_path: string | null
  mime: string
  extension: string | null
  score: number
}

type FolderSearchRow = {
  id: string
  name: string
  path: string
  score: number
}

export async function search(rawQuery: string): Promise<Array<SearchHit>> {
  const q = rawQuery.trim().toLowerCase()
  if (q.length < MIN_QUERY_LENGTH) return []

  const [docRows, folderRows] = await Promise.all([
    db.execute<DocumentSearchRow>(sql`
      SELECT d.id,
             d.name || case when d.extension is null then '' else '.' || d.extension end AS name,
             f.path AS folder_path,
             d.extension AS extension,
             fi.mime AS mime,
             word_similarity(${q}, d.search_haystack) AS score
      FROM document d
      JOIN file fi ON fi.id = d.file_id
      LEFT JOIN folder f ON f.id = d.folder_id
      WHERE d.deleted_at IS NULL
        AND word_similarity(${q}, d.search_haystack) > ${SCORE_THRESHOLD}
      ORDER BY score DESC, d.name ASC
      LIMIT ${DOCUMENT_LIMIT}
    `),
    db.execute<FolderSearchRow>(sql`
      SELECT id, name, path,
             word_similarity(${q}, search_haystack) AS score
      FROM folder
      WHERE deleted_at IS NULL
        AND word_similarity(${q}, search_haystack) > ${SCORE_THRESHOLD}
      ORDER BY score DESC, name ASC
      LIMIT ${FOLDER_LIMIT}
    `),
  ])

  const docHits: Array<SearchHit> = (docRows as Array<DocumentSearchRow>).map((row) => ({
    kind: 'document',
    id: row.id,
    name: row.name,
    path: row.folder_path,
    mime: row.mime,
    extension: row.extension,
    score: Number(row.score),
  }))
  const folderHits: Array<SearchHit> = (folderRows as Array<FolderSearchRow>).map((row) => ({
    kind: 'folder',
    id: row.id,
    name: row.name,
    path: row.path,
    score: Number(row.score),
  }))

  return mergeAndRank(docHits, folderHits)
}

// Stable sort by score DESC; on ties folders come first (navigation-useful).
function mergeAndRank(docs: Array<SearchHit>, folders: Array<SearchHit>): Array<SearchHit> {
  const all = [...folders, ...docs]
  return all.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
    return 0
  })
}
