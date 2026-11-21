# ClipBit — context for Claude Code

AI tool that records YouTube live streams (GTA 6 gameplay on the owner's channel), finds viral moments, renders
1080×1920 YouTube Shorts with captions / hook banner / sound effects / intro-outro, and uploads them to YouTube
**only after explicit human approval**. Single user, runs locally on Windows via Docker Desktop.

## Run / build

- Everything runs in Docker: `docker compose up -d --build` (or double-click `start.bat`). UI + API: http://localhost:8080
- After code changes: `rebuild.bat` → rebuilds `app` + `worker` (no cache) and `whisper`, recreates them, and writes
  diagnostics to `rebuild-log.txt` (build exit codes, a grep proving new code is in the image, `docker compose ps`,
  whisper + worker/app logs). Read that file to debug.
- Logs: `docker compose logs -f worker` (pipeline), `docker compose logs -f app` (API).
- Dev without Docker for the app: `cd server && npm i && npm run dev:api` / `npm run dev:worker`; `cd web && npm i && npm run dev` (proxies /api to :8080). Needs ffmpeg + yt-dlp on PATH.
- Typecheck: `cd server && npm run typecheck`. Note `npm run build` uses `tsc --noCheck` on purpose so typing quirks never break the Docker build — run typecheck yourself.
- Offline video tests (no DB/Redis/keys): `npx tsx scripts/pipeline-test.ts <video> <outDir>`, `scripts/aiedit-test.ts`, `scripts/mission-test.ts`.
- There are no unit-test suites; verify by running those scripts, typechecking, and checking the running app's `/api/system`.

## Layout

```
docker-compose.yml   postgres:16 · redis:7 · whisper (faster-whisper, :9000) · app · worker
                     media bind-mounted from ${DATA_PATH:-D:/clipforge-data} → /data
                     extra_hosts host.docker.internal → reach Ollama on the Windows host
Dockerfile           node:22 + ffmpeg (libass) + fonts + yt-dlp standalone binary (uses node as JS runtime)
whisper/app.py       FastAPI: GET /health (loaded/loading/busy), POST /transcribe (raw audio body → segments+words)
server/src
  server.ts          Fastify API + serves web/dist; optional basic auth (APP_PASSWORD)
  worker.ts          BullMQ workers + live-recorder supervisor (Redis leader lock)
  config.ts          env vars (DATA_DIR, GEMINI_*, OLLAMA_*, GOOGLE_*, STORAGE_DRIVER, concurrency…)
  settings*.ts       runtime settings in Postgres `settings` table (key 'app'); defaults in settings-defaults.ts
  queues.ts          queues: ingest · analyze · render · upload · maintenance
  db/migrations/     001_init · 002_edit_plan · 003_missions (applied automatically at start, advisory-locked)
  routes/api.ts      all REST endpoints
  workers/
    recorder.ts      yt-dlp → ffmpeg HLS → 60 s .ts chunks + segments.csv; reconnect/backoff; queues analyze jobs
    ingest.ts        VOD download / uploaded file → chunks
    analyze.ts       chunk → Whisper transcript + loudness/motion signals → AI moments (+ mission label)
    render.ts        clip (or multi-part mission Short) → AI edit plan → renderClip per part → concat → storage
    upload.ts        YouTube resumable upload (hard-gated on approval)
    maintenance.ts   YouTube stats every 6 h, raw-chunk retention cleanup hourly
  services/ai/
    providers.ts     routing: detect (default Ollama) / edit (default Gemini), automatic fallback to the other
    gemini.ts        REST client, prompts, moment schema, retired-model auto-switch, quota error class, health hook
    ollama.ts        local vision model via /api/chat with JSON-schema output; frames sent as ONE contact sheet
    editplan.ts      hook text, AI title, caption cleanup, highlight words, SFX cues (+ heuristic fallback)
    signals.ts / heuristic.ts / boundaries.ts / transcribe.ts / types.ts
  services/video/
    render.ts        assemble range → dead-air cut → reframe → ASS captions+hook → loudnorm/SFX mix → intro/outro concat → x264
    reframe.ts       16:9→9:16: smart (motion-saliency virtual camera via sendcmd crop), blur, center, split(facecam)
    captions.ts      animated word-highlight ASS + hook banner style
    deadair.ts, media.ts, sfx.ts (built-in synthesized SFX + user folder), branding.ts (intro/outro)
  services/youtube/client.ts  OAuth2 + encrypted tokens (AES-256-GCM with APP_SECRET)
web/src              React 18 + Vite, no UI library, hash router, polling via usePoll; pages/*.tsx, styles.css
```

## Data model (Postgres)

streams → sessions (one continuous recording) → chunks (60 s .ts files, transcript + signals + mission)
→ moments (AI-detected, score 0-100, title, category, mission, detector gemini|ollama|heuristic)
→ clips (kind single|mission, parts jsonb for mission Shorts, captions jsonb, options jsonb, edit_plan jsonb, version)
→ publications (YouTube uploads + stats). Times are **session seconds** everywhere (offset into the recording).

## Product rules (from the owner — keep them)

- **Nothing uploads without explicit approval** of that exact clip (checked in API *and* upload worker). Re-render ⇒ back to review.
- **No auto-rendering** by default (`autoClip: false`). Clips render only from "Generate clip" / "Create mission Short".
- **No placeholder moments** ("Wild moment at 5:47"). `heuristicFallback` is off; if AI is unavailable/quota-limited,
  chunks are retried later (20 min, up to 24 h) instead of inventing moments.
- Titles/hooks must describe what actually happens in the clip (the edit plan watches the clip before writing them).
- Clip length: min 20 s (owner request). Mission Shorts: 2–6 parts, target ~60 s, max 170 s.
- Every stream requires an ownership/permission confirmation; no DRM/access-control bypassing.
- No background music (copyright) unless the owner asks again.

## Technical notes

- Machine-specific notes (hardware, drives, local model choice) live in `CLAUDE.local.md`, which is git-ignored.
- Media lives outside the repo in `${DATA_PATH}` (default `D:\clipforge-data`: recordings/, media/clips, sfx/, branding/).
- Ollama vision models charge roughly 1k prompt tokens per image (8 separate frames ≈ 8.4k tokens ≈ 90 s/call on a home
  GPU), hence frames are sent as 3×2 contact-sheet grids. Use an *instruct* (non-thinking) model — thinking builds
  spend the whole output budget reasoning and return empty JSON.
- Gemini: free-tier key hits quota quickly (429). `gemini-2.5-flash` was retired → default `gemini-3.8-flash`;
  the client switches to the replacement Google names in a 404. Last Gemini status is in settings key `ai_health`.
- YouTube live streams expose only separate video-only + audio-only HLS formats → format selector
  `b[height<=1080][protocol*=m3u8]/b[height<=1080]/bv*[height<=1080]+ba/b/bv*+ba`; recorder maps two inputs.
  yt-dlp needs `--js-runtimes node --remote-components ejs:github`.
- Whisper must load its model in a background thread and transcribe in a thread pool (an earlier version blocked
  its event loop so /health timed out and analysis stalled).

## Gotchas

- The app was renamed ClipForge → ClipBit (2026-11-21). Internal names deliberately still say `clipforge` and must NOT be
  renamed: compose project name (volumes `clipforge_pgdata`…), Postgres user/db, the token-encryption salt in
  `lib/crypto.ts`, the Redis recorder lock key, and the data folder `D:\clipforge-data`.

- ffmpeg filter files (captions.ass, crop.cmd) are referenced relative to the work dir — renders run with `cwd=workDir`.
- Mission Shorts join already-encoded parts with the concat demuxer (`-c copy`); all parts must share encoder settings.
- BullMQ jobs that wait (live clip past recorded end, Gemini quota) use `job.moveToDelayed` + `DelayedError`; the
  processor needs the `token` argument.
- Settings are cached 5 s in-process; `saveSettings` deep-merges partial objects.
- Gemini schemas use OpenAPI-style uppercase types; `ollama.ts#toJsonSchema` converts them for Ollama.
- On Windows `.bat` files must have CRLF line endings.
- Status/diagnostics endpoint: `GET /api/system` (gemini/ollama/whisper/yt-dlp/queues/ai_health).

## Status / next ideas

Working end-to-end on the PC: recording, analysis, rendering, AI edit, intro/outro, missions UI.
Verified live: YouTube OAuth + upload, saved full recordings. Not yet verified live: mission Shorts on real footage.
Ideas: face-aware smart crop, zoom punch-ins, larger local vision model, royalty-free music folder.
