-- Add 'rivian' to the oauth_tokens.provider check constraint so Rivian
-- (unofficial GraphQL API) can store its session/refresh tokens in the
-- same row shape as Enphase/Smartcar/Tesla.
--
-- Storage convention (mirrors lib/rivian/auth.ts comments):
--   access_token   = userSessionToken (passed as `u-sess` header)
--   refresh_token  = refreshToken     (used by refreshAccessToken mutation)
--   system_id      = vehicle UUID     (Rivian's per-vehicle ID, not VIN)
--   meta           = { a_sess, csrf_token, access_token } — short-lived
--                    tokens needed alongside u-sess for every GraphQL call.
--
-- The original CHECK constraint in 0003_oauth_tokens.sql was inline on
-- the column. Postgres auto-named it `oauth_tokens_provider_check` and
-- normalized the inline IN(...) expression to `= ANY (ARRAY[...])` —
-- which trips up text-pattern lookups but is harmless to our explicit
-- DROP-by-name. Existing rows for the four pre-existing providers stay
-- valid since we're widening the allowed set, not narrowing it.

ALTER TABLE oauth_tokens DROP CONSTRAINT oauth_tokens_provider_check;
ALTER TABLE oauth_tokens ADD CONSTRAINT oauth_tokens_provider_check
  CHECK (provider IN ('enphase','smartcar','tesla','rivian'));
