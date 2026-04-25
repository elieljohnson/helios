-- OAuth token storage for provider integrations (Enphase, Smartcar,
-- Tesla Fleet, …). Single row per provider in the single-tenant MVP;
-- when this app goes multi-tenant, prepend a household_id FK and shift
-- the primary key to (household_id, provider).
--
-- expires_at tracks the access_token TTL — the client wrapper uses it
-- to decide when to call /oauth/token with the refresh_token before
-- making a request. system_id holds the provider's primary handle:
--   enphase  → system_id (the homeowner's Enphase array)
--   smartcar → vehicle_id
--   tesla    → vehicle_id (VIN)

CREATE TABLE IF NOT EXISTS oauth_tokens (
  provider       TEXT PRIMARY KEY
                  CHECK (provider IN ('enphase','smartcar','tesla')),
  access_token   TEXT NOT NULL,
  refresh_token  TEXT NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  system_id      TEXT,
  meta           JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
