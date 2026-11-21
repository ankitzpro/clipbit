import path from 'node:path';

const env = process.env;
const int = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);

const dataDir = path.resolve(env.DATA_DIR || './data');

export const config = {
  port: int(env.PORT, 8080),
  publicUrl: (env.PUBLIC_URL || `http://localhost:${int(env.PORT, 8080)}`).replace(/\/$/, ''),
  databaseUrl: env.DATABASE_URL || 'postgres://clipforge:clipforge@localhost:5432/clipforge',
  redisUrl: env.REDIS_URL || 'redis://localhost:6379',
  appSecret: env.APP_SECRET || 'dev-insecure-secret',
  appPassword: env.APP_PASSWORD || '',
  webDist: env.WEB_DIST ? path.resolve(env.WEB_DIST) : path.resolve('../web/dist'),

  dataDir,
  dirs: {
    recordings: path.join(dataDir, 'recordings'),
    media: path.join(dataDir, 'media'),
    work: path.join(dataDir, 'work'),
    uploads: path.join(dataDir, 'uploads'),
    cache: path.join(dataDir, 'cache'),
  },

  ytdlpBin: env.YTDLP_BIN || 'yt-dlp',
  ffmpegBin: env.FFMPEG_BIN || 'ffmpeg',
  ffprobeBin: env.FFPROBE_BIN || 'ffprobe',

  gemini: {
    apiKey: env.GEMINI_API_KEY || '',
    model: env.GEMINI_MODEL || 'gemini-3.8-flash',
  },
  whisperUrl: env.WHISPER_URL || '',
  ollama: {
    // Ollama running on your PC (Docker Desktop exposes the host as host.docker.internal)
    url: (env.OLLAMA_URL ?? 'http://host.docker.internal:11434').replace(/\/$/, ''),
    model: env.OLLAMA_MODEL || 'qwen2.5vl:3b',
  },

  google: {
    clientId: env.GOOGLE_CLIENT_ID || '',
    clientSecret: env.GOOGLE_CLIENT_SECRET || '',
  },

  concurrency: {
    analyze: int(env.ANALYZE_CONCURRENCY, 2),
    render: int(env.RENDER_CONCURRENCY, 1),
    upload: int(env.UPLOAD_CONCURRENCY, 1),
  },

  storage: {
    driver: (env.STORAGE_DRIVER || 'local') as 'local' | 's3',
    bucket: env.S3_BUCKET || '',
    region: env.S3_REGION || 'auto',
    endpoint: env.S3_ENDPOINT || '',
    accessKeyId: env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: env.S3_SECRET_ACCESS_KEY || '',
  },
};

export const youtubeRedirectUri = () => `${config.publicUrl}/api/youtube/callback`;
