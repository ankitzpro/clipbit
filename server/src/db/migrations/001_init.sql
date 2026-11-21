CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS streams (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  url           text,                       -- YouTube live/channel/VOD URL (null for uploaded files)
  kind          text NOT NULL,              -- live | channel | vod | file
  status        text NOT NULL DEFAULT 'offline', -- live | offline | processing | completed | error | paused
  paused        boolean NOT NULL DEFAULT false,
  permission_confirmed boolean NOT NULL DEFAULT false,
  source_title  text,
  last_error    text,
  last_checked_at timestamptz,
  next_check_at timestamptz,
  fail_count    int NOT NULL DEFAULT 0,
  options       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- per-stream overrides: reframeMode, facecam rect, ...
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One continuous recording (a live broadcast between reconnects, or one VOD/file)
CREATE TABLE IF NOT EXISTS sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id   uuid NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  dir         text NOT NULL,
  title       text,
  active      boolean NOT NULL DEFAULT true,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz
);
CREATE INDEX IF NOT EXISTS sessions_stream_idx ON sessions(stream_id);

CREATE TABLE IF NOT EXISTS chunks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  stream_id   uuid NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  idx         int NOT NULL,
  file        text NOT NULL,              -- absolute path on the shared data volume
  start_sec   double precision NOT NULL,  -- offset inside the session
  end_sec     double precision NOT NULL,
  status      text NOT NULL DEFAULT 'pending', -- pending | analyzing | analyzed | failed | purged
  transcript  jsonb,                      -- [{start,end,text,words:[{start,end,word}]}] (session time)
  signals     jsonb,                      -- {loudness:[..per sec], scene:[..], peaks:[..]}
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id, idx)
);
CREATE INDEX IF NOT EXISTS chunks_session_idx ON chunks(session_id, start_sec);

CREATE TABLE IF NOT EXISTS moments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id   uuid NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  chunk_id    uuid REFERENCES chunks(id) ON DELETE SET NULL,
  start_sec   double precision NOT NULL,
  end_sec     double precision NOT NULL,
  peak_sec    double precision,
  title       text NOT NULL,
  description text,
  category    text,                       -- funny | action | unexpected | reaction | commentary | fail | win | other
  score       int NOT NULL,
  hashtags    text[] NOT NULL DEFAULT '{}',
  keywords    text[] NOT NULL DEFAULT '{}',
  transcript  text,
  detector    text NOT NULL,              -- gemini | heuristic
  status      text NOT NULL DEFAULT 'new',-- new | clipped | dismissed
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS moments_stream_idx ON moments(stream_id, created_at DESC);

CREATE TABLE IF NOT EXISTS clips (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  moment_id   uuid REFERENCES moments(id) ON DELETE SET NULL,
  stream_id   uuid REFERENCES streams(id) ON DELETE SET NULL,
  session_id  uuid REFERENCES sessions(id) ON DELETE SET NULL,
  status      text NOT NULL DEFAULT 'queued', -- queued | rendering | ready | approved | rejected | failed | published
  start_sec   double precision NOT NULL,
  end_sec     double precision NOT NULL,
  duration    double precision,
  title       text NOT NULL,
  description text,
  hashtags    text[] NOT NULL DEFAULT '{}',
  score       int,
  category    text,
  captions    jsonb,                      -- {segments:[{start,end,text,words?}]} in session time
  options     jsonb NOT NULL DEFAULT '{}'::jsonb, -- {reframeMode, captions, deadAir}
  file_key    text,
  thumb_key   text,
  progress    int NOT NULL DEFAULT 0,
  error       text,
  reject_reason text,
  version     int NOT NULL DEFAULT 0,
  approved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clips_status_idx ON clips(status, created_at DESC);

CREATE TABLE IF NOT EXISTS youtube_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id    text NOT NULL UNIQUE,
  channel_title text,
  thumbnail     text,
  tokens_enc    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS publications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clip_id     uuid NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  account_id  uuid REFERENCES youtube_accounts(id) ON DELETE SET NULL,
  status      text NOT NULL DEFAULT 'queued', -- queued | uploading | scheduled | published | failed
  privacy     text NOT NULL DEFAULT 'private',
  publish_at  timestamptz,
  title       text NOT NULL,
  description text,
  tags        text[] NOT NULL DEFAULT '{}',
  youtube_video_id text,
  progress    int NOT NULL DEFAULT 0,
  attempts    int NOT NULL DEFAULT 0,
  error       text,
  stats       jsonb,
  stats_updated_at timestamptz,
  approved_by_user_at timestamptz NOT NULL,   -- explicit approval timestamp captured at queue time
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS publications_clip_idx ON publications(clip_id);

CREATE TABLE IF NOT EXISTS settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);
