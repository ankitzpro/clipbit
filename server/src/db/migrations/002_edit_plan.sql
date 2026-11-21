-- AI edit plan per clip: hook banner text, cleaned captions, highlight words, sound-effect cues
ALTER TABLE clips ADD COLUMN IF NOT EXISTS edit_plan jsonb;
