-- Full-length saved recordings: when a stream has options.saveFullRecording, each finished session's 2-minute
-- chunks are joined (stream copy) into one MP4 kept in media storage, never removed by the raw-chunk retention job.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS recording_status   text;               -- NULL | queued | saving | ready | failed
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS recording_key      text;               -- storage key, e.g. recordings/<stream>/<session>.mp4
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS recording_bytes    bigint;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS recording_duration double precision;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS recording_error    text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS recording_saved_at timestamptz;
