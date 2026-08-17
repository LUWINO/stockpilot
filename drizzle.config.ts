import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/server/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/stockpilot',
  },
  // Fail loudly on a destructive change rather than silently dropping a column.
  strict: true,
  verbose: true,
});
