-- Live progress of a VOD / file import, shown on the stream card:
-- { phase: checking|downloading|converting|splitting, pct, doneSec, totalSec, speed, etaSec, note, at }
-- NULL when no import is running.
ALTER TABLE streams ADD COLUMN IF NOT EXISTS ingest_progress jsonb;
