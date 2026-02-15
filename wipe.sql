-- Wipe ALL data (keep tables)

DELETE FROM queued_realtime;
DELETE FROM meta_kv;

DELETE FROM deliveries;
DELETE FROM user_state;

DELETE FROM scraped_posts;

DELETE FROM user_sources;
DELETE FROM user_prefs;

DELETE FROM sources;
DELETE FROM destinations;

DELETE FROM pending_claims;
DELETE FROM users;

DELETE FROM locks;
