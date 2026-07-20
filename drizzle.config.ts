import { defineConfig } from 'drizzle-kit'
import { resolveUnpooledUrl } from './src/lib/db/connectionString'

// Migrations use the unpooled/direct connection (:5432); on Vercel that arrives
// as POSTGRES_URL_NON_POOLING from the Supabase integration. See connectionString.ts.
const url = resolveUnpooledUrl() ?? ''
const isLocal = url.includes('localhost') || url.includes('127.0.0.1')

if (isLocal) {
  // Neon Local uses self-signed certs. node-postgres (which drizzle-kit uses)
  // treats sslmode=require as verify-full, rejecting them. Skip cert
  // verification for local only — never leaks to prod (Neon cloud has valid certs).
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/lib/db/schema',
  out: './drizzle',
  dbCredentials: { url },
  casing: 'snake_case',
})
