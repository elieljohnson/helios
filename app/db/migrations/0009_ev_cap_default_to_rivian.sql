-- Bump ev_solar_boost_cap_pct default from 85 → 100 so it acts as a
-- pure override on top of the Rivian's own charge limit instead of
-- imposing an opinionated 5%-above ceiling.
--
-- Engine semantics: stop EV at min(snapshot.ev_target, ev_solar_boost_cap_pct).
-- Default 100 means "respect Rivian's setting"; user lowers this only
-- to enforce a stricter ceiling than Rivian.
--
-- Also updates the existing user_config row from 85 → 100 since this
-- is a single-tenant install. New installs would already get 100.

ALTER TABLE user_config
  ALTER COLUMN ev_solar_boost_cap_pct SET DEFAULT 100;

UPDATE user_config
   SET ev_solar_boost_cap_pct = 100
 WHERE ev_solar_boost_cap_pct = 85;
