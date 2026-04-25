import { defineConfig } from "drizzle-kit";

// Run `npm run db:generate` to produce migrations from src/db/schema.ts.
// Run `npm run db:push` to apply them to the DATABASE_URL.
//
// The handwritten db/migrations/0001_init.sql is the canonical initial
// migration — drizzle-kit generated migrations start at 0002.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
