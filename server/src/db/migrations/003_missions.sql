-- Mission labels (from Gemini) and multi-part "mission Shorts"
ALTER TABLE chunks  ADD COLUMN IF NOT EXISTS mission text;
ALTER TABLE moments ADD COLUMN IF NOT EXISTS mission text;
ALTER TABLE clips   ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'single';   -- single | mission
ALTER TABLE clips   ADD COLUMN IF NOT EXISTS parts jsonb;                            -- [{start,end,momentId}] for mission Shorts
CREATE INDEX IF NOT EXISTS moments_mission_idx ON moments(session_id, mission);

-- Remove placeholder moments from the basic detector ("Wild moment at 5:47") and their un-reviewed clips
DELETE FROM clips WHERE status IN ('queued','rendering','ready','failed','rejected')
  AND moment_id IN (SELECT id FROM moments WHERE detector = 'heuristic');
DELETE FROM moments WHERE detector = 'heuristic'
  AND id NOT IN (SELECT moment_id FROM clips WHERE moment_id IS NOT NULL);
