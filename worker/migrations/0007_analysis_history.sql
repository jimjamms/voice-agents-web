CREATE TABLE IF NOT EXISTS metrics_analysis_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_id TEXT NOT NULL,
  data_fingerprint TEXT NOT NULL,
  analysis_version TEXT NOT NULL,
  model TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(name_id, data_fingerprint, analysis_version, model)
);
INSERT OR IGNORE INTO metrics_analysis_history(name_id,data_fingerprint,analysis_version,model,payload,created_at)
SELECT name_id,data_fingerprint,analysis_version,model,payload,created_at FROM metrics_analyses;
CREATE TRIGGER IF NOT EXISTS metrics_history_insert AFTER INSERT ON metrics_analyses BEGIN
  INSERT INTO metrics_analysis_history(name_id,data_fingerprint,analysis_version,model,payload,created_at)
  VALUES(NEW.name_id,NEW.data_fingerprint,NEW.analysis_version,NEW.model,NEW.payload,NEW.created_at) ON CONFLICT(name_id,data_fingerprint,analysis_version,model) DO NOTHING;
END;
CREATE TRIGGER IF NOT EXISTS metrics_history_update AFTER UPDATE ON metrics_analyses BEGIN
  INSERT INTO metrics_analysis_history(name_id,data_fingerprint,analysis_version,model,payload,created_at)
  VALUES(OLD.name_id,OLD.data_fingerprint,OLD.analysis_version,OLD.model,OLD.payload,OLD.created_at) ON CONFLICT(name_id,data_fingerprint,analysis_version,model) DO NOTHING;
  INSERT INTO metrics_analysis_history(name_id,data_fingerprint,analysis_version,model,payload,created_at)
  VALUES(NEW.name_id,NEW.data_fingerprint,NEW.analysis_version,NEW.model,NEW.payload,NEW.created_at) ON CONFLICT(name_id,data_fingerprint,analysis_version,model) DO NOTHING;
END;
CREATE TRIGGER IF NOT EXISTS metrics_history_delete AFTER DELETE ON metrics_analyses BEGIN
  DELETE FROM metrics_analysis_history WHERE name_id=OLD.name_id;
END;
