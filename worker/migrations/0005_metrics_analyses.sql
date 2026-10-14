CREATE TABLE IF NOT EXISTS metrics_analyses (
  name_id TEXT PRIMARY KEY,
  data_fingerprint TEXT NOT NULL,
  analysis_version TEXT NOT NULL,
  model TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
