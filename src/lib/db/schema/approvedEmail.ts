import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const approvedEmail = pgTable('approved_email', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  role: text('role', { enum: ['user', 'admin'] }).notNull().default('user'),
  addedByUserId: uuid('added_by_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
