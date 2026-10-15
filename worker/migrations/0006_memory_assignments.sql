CREATE TABLE IF NOT EXISTS memory_assignments (
  name_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK(mode IN ('shared', 'isolated')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Preserve the most recent recorded mode of every existing Name ID.
INSERT OR IGNORE INTO memory_assignments(name_id, mode)
SELECT names.name_id, COALESCE(
  (SELECT json_extract(c.payload, '$.memory_sharing_mode') FROM chat_turns c
   WHERE c.speaker_lower = names.name_id AND json_extract(c.payload, '$.memory_sharing_mode') IN ('shared','isolated')
   ORDER BY c.id DESC LIMIT 1),
  CASE WHEN (COALESCE(json_array_length(p.payload, '$.memories.sage'),0) + COALESCE(json_array_length(p.payload, '$.memories.astra'),0)) > 0
    AND COALESCE(json_array_length(p.payload, '$.memories.shared'),0) = 0 THEN 'isolated' ELSE 'shared' END)
FROM (SELECT name_id FROM trip_profiles UNION SELECT speaker_lower FROM chat_turns WHERE speaker_lower != 'unknown') names
LEFT JOIN trip_profiles p ON p.name_id = names.name_id;
