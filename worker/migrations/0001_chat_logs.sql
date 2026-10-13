CREATE TABLE IF NOT EXISTS chat_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id TEXT NOT NULL UNIQUE,
  participant_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  speaker_lower TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  payload TEXT NOT NULL,
  interrupted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS chat_turns_speaker ON chat_turns(speaker_lower, id);
CREATE INDEX IF NOT EXISTS chat_turns_participant ON chat_turns(participant_id, id);
