-- Separate from profiles so deleting/recreating a trip does not reset survey eligibility.
CREATE TABLE IF NOT EXISTS survey_receipts (
  token TEXT PRIMARY KEY,
  response_id TEXT UNIQUE,
  edit_url TEXT,
  submitted_at TEXT
);
