-- Charger telemetry — singleton "latest known state" for the L2 EV
-- charger. Designed source-agnostic: the ingest endpoint translates
-- vendor-specific payloads (Tesla Wall Connector vitals today, possibly
-- Emporia Vue / smart plug / etc. later) into this normalized shape.
--
-- Singleton pattern: id is fixed to 1 and upserted on every poll. We
-- don't keep history here — energy_snapshots already captures every
-- snapshot tick with ev_w, so this table is just "what's the charger
-- doing right now?" The raw payload is preserved in `raw` for
-- debugging and future schema evolution without a migration.
--
-- Staleness is read-side: assembleStatus() checks (NOW() - ingested_at)
-- and falls through to the mock if older than ~60s, treating a dead
-- poller as offline rather than serving stale wattage.

CREATE TABLE IF NOT EXISTS wall_connector_state (
  id                  INTEGER PRIMARY KEY DEFAULT 1
                        CHECK (id = 1),
  vehicle_connected   BOOLEAN NOT NULL,
  is_charging         BOOLEAN NOT NULL,
  power_w             INTEGER NOT NULL,
  session_energy_wh   INTEGER NOT NULL DEFAULT 0,
  session_seconds     INTEGER NOT NULL DEFAULT 0,
  lifetime_energy_wh  BIGINT,
  voltage_v           REAL,
  current_a           REAL,
  evse_state          INTEGER,
  raw                 JSONB,
  ingested_at         TIMESTAMPTZ NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
