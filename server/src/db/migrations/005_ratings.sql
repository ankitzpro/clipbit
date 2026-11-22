-- Evidence-based scores + the owner's own star ratings.
-- moments.score is now computed by ClipBit from an AI checklist + measured audio/visual signals (see
-- services/ai/scoring.ts); score_breakdown explains it. user_rating (1-5 stars) teaches the scorer the owner's taste.
ALTER TABLE moments ADD COLUMN IF NOT EXISTS score_breakdown jsonb;
ALTER TABLE moments ADD COLUMN IF NOT EXISTS user_rating     smallint CHECK (user_rating BETWEEN 1 AND 5);
ALTER TABLE clips   ADD COLUMN IF NOT EXISTS user_rating     smallint CHECK (user_rating BETWEEN 1 AND 5);
