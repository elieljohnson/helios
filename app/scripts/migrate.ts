// Helios migration runner.
//
// Why custom over drizzle-kit migrate: the project's existing
// convention is handwritten SQL files (with intent comments,
// future-evolution notes, etc.) — `drizzle-kit migrate` expects its
// own meta/_journal.json + per-migration snapshot files generated
// from schema.ts. Adopting it means either abandoning handwritten
// SQL or maintaining both formats. This runner is ~120 lines of
// code that preserves the convention as-is.
//
// Behavior:
//   - Connects via DATABASE_URL.
//   - Ensures `_helios_migrations` tracking table exists (id, applied_at).
//   - Lists db/migrations/*.sql, sorted lexically.
//   - For each NOT-yet-applied file: BEGIN → run SQL → INSERT row → COMMIT.
//   - Logs each step + the elapsed ms.
//
// Modes:
//   (default)  apply pending migrations.
//   --check    list pending without applying. Exits non-zero if any pending.
//   --bootstrap   populate _helios_migrations with all current filenames as
//                 already-applied. Use ONCE on a database where migrations
//                 were applied manually before the runner existed.
//   --status   list every known migration with applied/pending state.
//
// Safety:
//   - Each migration runs in its own transaction (PG DDL is transactional).
//   - Filename is the migration ID. Renaming an applied migration is
//     equivalent to a fresh migration — caller's responsibility.
//   - Pre-existing migration files MUST be applied (or bootstrapped) before
//     deploying any new migration that depends on them.
//
// Run:
//   node --env-file=.env.local --import tsx scripts/migrate.ts
//   node --env-file=.env.local --import tsx scripts/migrate.ts --check
//   node --env-file=.env.local --import tsx scripts/migrate.ts --bootstrap
//   node --env-file=.env.local --import tsx scripts/migrate.ts --status

import { promises as fs } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const MIGRATIONS_DIR = join(process.cwd(), "db", "migrations");
const TRACKING_TABLE = "_helios_migrations";

type Mode = "apply" | "check" | "bootstrap" | "status";

function parseMode(argv: string[]): Mode {
  if (argv.includes("--check")) return "check";
  if (argv.includes("--bootstrap")) return "bootstrap";
  if (argv.includes("--status")) return "status";
  return "apply";
}

async function listMigrationFiles(): Promise<string[]> {
  const entries = await fs.readdir(MIGRATIONS_DIR);
  return entries
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));
}

async function readMigration(name: string): Promise<string> {
  return fs.readFile(join(MIGRATIONS_DIR, name), "utf-8");
}

void (async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required (set in .env.local).");
    process.exit(1);
  }
  const mode = parseMode(process.argv);
  const sql = postgres(url, {
    max: 2,
    prepare: false,
    // Suppress informational notices ("relation X already exists,
    // skipping" etc.) — expected during normal runs since CREATE TABLE
    // IF NOT EXISTS triggers them. Real errors come back as thrown
    // promise rejections, not notices.
    onnotice: () => {},
  });

  try {
    // Ensure tracking table — idempotent.
    await sql`
      CREATE TABLE IF NOT EXISTS ${sql(TRACKING_TABLE)} (
        id          text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT NOW()
      )
    `;

    const allFiles = await listMigrationFiles();
    const applied = new Set<string>(
      (
        await sql<{ id: string }[]>`SELECT id FROM ${sql(TRACKING_TABLE)}`
      ).map((r) => r.id),
    );
    const pending = allFiles.filter((f) => !applied.has(f));

    // ---- --status: just report ----
    if (mode === "status") {
      console.log(`Migration status (${allFiles.length} known, ${applied.size} applied):\n`);
      for (const f of allFiles) {
        const tag = applied.has(f) ? "✅ applied " : "⏳ pending ";
        console.log(`  ${tag}  ${f}`);
      }
      return;
    }

    // ---- --check: report pending, exit non-zero if any ----
    if (mode === "check") {
      if (pending.length === 0) {
        console.log("✅ all migrations applied; nothing pending.");
        return;
      }
      console.log(`⚠️  ${pending.length} migration(s) pending:`);
      for (const f of pending) console.log(`     ${f}`);
      process.exit(1);
    }

    // ---- --bootstrap: mark all known migrations as already-applied ----
    if (mode === "bootstrap") {
      if (applied.size > 0) {
        console.log(
          `Bootstrap warning: ${applied.size} migration(s) already tracked. Will skip those and bootstrap any untracked.`,
        );
      }
      const toMark = allFiles.filter((f) => !applied.has(f));
      if (toMark.length === 0) {
        console.log("Nothing to bootstrap — all known migrations already tracked.");
        return;
      }
      console.log(`Bootstrapping ${toMark.length} migration(s) as already-applied:`);
      for (const f of toMark) {
        await sql`INSERT INTO ${sql(TRACKING_TABLE)} (id) VALUES (${f})`;
        console.log(`  ✓ ${f}`);
      }
      console.log("Done. Future runs will only apply migrations not in this set.");
      return;
    }

    // ---- default: apply pending ----
    if (pending.length === 0) {
      console.log("✅ all migrations applied; nothing to do.");
      return;
    }
    console.log(`Applying ${pending.length} migration(s)…\n`);
    for (const file of pending) {
      const ddl = await readMigration(file);
      console.log(`→ ${file}`);
      const t0 = Date.now();
      await sql.begin(async (tx) => {
        // postgres-js's tagged template won't run multi-statement scripts
        // by default; .unsafe() bypasses that for full-file SQL.
        await tx.unsafe(ddl);
        await tx`INSERT INTO ${tx(TRACKING_TABLE)} (id) VALUES (${file})`;
      });
      console.log(`  ✓ applied (${Date.now() - t0}ms)`);
    }
    console.log(`\n✅ ${pending.length} migration(s) applied.`);
  } finally {
    await sql.end();
  }
})();
