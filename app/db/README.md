# Helios database migrations

Handwritten SQL migrations applied by a small custom runner
(`scripts/migrate.ts`). The convention is:

1. SQL files in `db/migrations/` named `NNNN_<short_description>.sql`
   (zero-padded sequential).
2. Each migration is one transactional unit. Postgres DDL is
   transactional, so multi-statement files run atomically.
3. The runner tracks applied migrations in a `_helios_migrations`
   table on the target DB. Applying is idempotent — already-applied
   migrations are skipped.

## Workflows

### Adding a new migration

```bash
# 1. Create the file. Number is one greater than the highest existing.
$EDITOR db/migrations/0006_short_description.sql

# 2. Apply locally (using DATABASE_URL from .env.local).
npm run db:migrate

# 3. Push the SQL file. Vercel deploys automatically; the migration
# does NOT run automatically on deploy — apply it manually before
# the deploy that depends on it.

# 4. Apply to prod. (Prod's DATABASE_URL is the same as .env.local
# in this single-environment setup; in a multi-env world this would
# point at a separate prod URL.)
npm run db:migrate
```

### Checking migration status

```bash
# List every migration with applied/pending state.
npm run db:migrate:status

# Exit non-zero if anything pending. Useful in CI.
npm run db:migrate:check
```

### Bootstrapping a database where migrations were applied manually

If migrations were applied via psql / Neon console before this runner
existed, mark them as already-applied without re-running:

```bash
npm run db:migrate:bootstrap
```

This is a one-time operation per environment.

## Why custom rather than drizzle-kit migrate

Drizzle-kit's runner expects its own `meta/_journal.json` +
per-migration snapshot files generated from `src/db/schema.ts`. The
project's convention is handwritten SQL files with intent comments
and future-evolution notes — preserving that convention while using
drizzle-kit would mean maintaining both formats. ~120 lines of
custom code keeps the existing convention as the single source of
truth.

`drizzle-kit generate` and `drizzle-kit push` are still available
(`npm run db:generate` and `npm run db:push`) for ad-hoc schema
diffing against `src/db/schema.ts` — useful for catching
schema drift but not on the migration-application path.

## Tracking table schema

```sql
CREATE TABLE IF NOT EXISTS _helios_migrations (
  id          text PRIMARY KEY,    -- the migration filename
  applied_at  timestamptz NOT NULL DEFAULT NOW()
);
```
