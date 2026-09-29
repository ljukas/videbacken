import { defineConfig } from 'drizzle-kit'
import { resolveUnpooledUrl } from './src/lib/db/connectionString'

// Migrations use the unpooled/direct connection (:5432); on Vercel that arrives
// as POSTGRES_URL_NON_POOLING from the Supabase integration. See connectionString.ts.
const url = resolveUnpooledUrl() ?? ''

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/lib/db/schema',
  out: './drizzle',
  dbCredentials: { url },
  casing: 'snake_case',
})
