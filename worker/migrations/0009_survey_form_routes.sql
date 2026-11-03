-- Preserve existing tokens, submission locks, and memory assignments.
ALTER TABLE survey_receipts ADD COLUMN form_url TEXT;
