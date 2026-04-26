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
-- the column, so its auto-generated name is normally
-- `oauth_tokens_provider_check` but a defensive lookup avoids depending
-- on that. Existing rows for the four pre-existing providers stay valid
-- since we're widening the allowed set, not narrowing it.

DO $$
DECLARE
  cname text;
BEGIN
  SELECT conname INTO cname
  FROM pg_constraint
  WHERE conrelid = 'oauth_tokens'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%provider%IN%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE oauth_tokens DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE oauth_tokens ADD CONSTRAINT oauth_tokens_provider_check
  CHECK (provider IN ('enphase','smartcar','tesla','rivian'));
