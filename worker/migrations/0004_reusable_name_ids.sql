ALTER TABLE deleted_name_ids ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
-- Previously disabled trip IDs become empty, reusable profiles.
INSERT INTO trip_profiles(name_id, payload, version)
SELECT name_id, '{"notes":"","choices":{"countries":[],"cities":[],"activities":[],"budget":null,"itinerary":null,"finalized":false},"memories":{"shared":[],"sage":[],"astra":[]}}', 1
FROM deleted_name_ids WHERE trip_blocked = 1
ON CONFLICT(name_id) DO UPDATE SET payload = excluded.payload, version = trip_profiles.version + 1;
UPDATE deleted_name_ids SET generation = 1, trip_blocked = 0 WHERE trip_blocked = 1;
