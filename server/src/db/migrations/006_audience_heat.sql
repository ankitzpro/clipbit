-- YouTube "Most replayed" heatmap of a past broadcast / video (from yt-dlp's `heatmap`), when YouTube has one.
-- [{ "s": start_sec, "e": end_sec, "v": 0..1 }] in session seconds (= video seconds for a VOD). Real-audience signal for scoring.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS heatmap jsonb;
