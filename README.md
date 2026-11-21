# ClipBit — AI YouTube Live Stream → Shorts generator

ClipBit watches YouTube live streams (or past broadcasts / your own recordings), finds the funny, intense and
viral‑worthy moments with AI, turns them into polished **1080×1920 YouTube Shorts** with animated captions, and
uploads them to your channel **only after you approve each one**.

```
YouTube live / channel / VOD / uploaded file
        │  yt-dlp + ffmpeg (60 s chunks, auto‑reconnect)
        ▼
  chunk ──► Whisper transcript ─┐
        ──► loudness + motion ──┼─► Gemini (video+audio+transcript)  ──► moments (score 0‑100, title, hashtags…)
                                │   or signal heuristic (no key)                │ auto‑clip if score ≥ threshold
                                ▼                                               ▼
                        learning profile ◄── approvals / rejections / YouTube stats      render: trim → dead‑air cut → 9:16 reframe
                                                                                         → animated captions → −14 LUFS → H.264
                                                                                                │
                                                                Approval Queue (you) ◄──────────┘
                                                                        │ approve + publish
                                                                        ▼
                                                     YouTube Data API v3 (OAuth 2.0, resumable upload, scheduling)
```

## What's in this build

| Phase | Feature | Status |
|---|---|---|
| 1 | Add live / channel / VOD URLs or upload a recording | ✅ |
| 1 | Continuous recording in chunks, auto‑reconnect, pause/resume/remove | ✅ |
| 1 | AI moment detection (Gemini multimodal) + key‑free fallback (audio/visual/speech signals) | ✅ |
| 1 | Viral score, title, description, why‑it's‑good, transcript, hashtags per moment | ✅ |
| 1 | 10–60 s clips with sentence‑aware boundaries & lead‑in/reaction tail | ✅ |
| 1 | 9:16 reframing: **smart crop** (motion‑tracking virtual camera), blur‑fit, center, facecam split | ✅ |
| 1 | 1080×1920 H.264/AAC, loudness‑normalised, thumbnails | ✅ |
| 1 | Approval dashboard, edit title/desc/hashtags, trim, regenerate, download | ✅ |
| 2 | YouTube OAuth, encrypted tokens, upload with progress, schedule, retry, history | ✅ |
| 3 | Whisper word‑level animated captions with keyword highlighting, editable subtitles | ✅ |
| 3 | Dead‑air removal | ✅ |
| 3 | Multiple simultaneous streams | ✅ (1 recorder per stream, workers scale) |
| 3 | Analytics (views, likes, comments, retention, engagement) + learning loop | ✅ basic |
| 3 | Face‑detection based tracking | 🔜 (smart crop currently tracks motion saliency) |

## Quick start (Windows)

1. Install **Docker Desktop** and start it.
2. Double‑click **`start.bat`**. The first time it creates `.env` and opens it in Notepad:
   - `GEMINI_API_KEY` — free key from https://aistudio.google.com/apikey (optional but strongly recommended)
   - `APP_SECRET` — any long random string (encrypts your YouTube tokens)
   - Google OAuth keys — only needed for uploading (see below)
3. Run **`start.bat`** again. The first build takes several minutes. Open **http://localhost:8080**.

On Mac/Linux: `cp .env.example .env`, edit it, then `docker compose up -d --build`.

`stop.bat` (or `docker compose down`) stops everything. Videos are stored in `D:\clipforge-data`; the database lives in a Docker volume. Both survive restarts.

### Connect YouTube (Phase 2)

1. https://console.cloud.google.com → create a project.
2. **APIs & Services → Library** → enable **YouTube Data API v3** (and **YouTube Analytics API** for retention stats).
3. **OAuth consent screen** → External → add your Google account as a **Test user**.
   Scopes: `youtube.upload`, `youtube.readonly`, `yt-analytics.readonly`.
4. **Credentials → Create credentials → OAuth client ID → Web application**.
   Authorised redirect URI: `http://localhost:8080/api/youtube/callback`
5. Put the client ID/secret in `.env`, run `start.bat` again, then **Settings → Connect YouTube**.

> Google note: videos uploaded through an **unverified** API project are locked to *private* until the project passes
> Google's API audit. For personal use, upload as private and flip them to public in YouTube Studio, or apply for the
> audit. The default upload quota (10,000 units/day) allows ~6 uploads per day.

## How to use

1. **Live Monitor → Add stream**. Paste a live URL, a channel URL (`youtube.com/@you` — it's checked every ~90 s and
   recording starts automatically when you go live), a past broadcast, or upload a recording file. You must confirm you own
   the content or have permission.
2. Every 60 s chunk is transcribed and analysed. **Detected Moments** fills up with scored highlights.
   Moments scoring above the auto‑clip threshold (Settings) are rendered automatically; others have a *Generate clip* button.
3. **Approval Queue** → watch each Short, approve or reject (rejection reasons teach the AI your taste).
4. **Clip Studio** → fine‑tune: trim with the original 16:9 footage, switch framing, toggle captions/dead‑air removal,
   edit subtitles, AI‑rewrite title. Any re‑render sends the clip back for approval.
5. **Publish** (approved clips only) → now or scheduled, with visibility. Track progress in **Publishing**.
6. **Analytics** → views, likes, retention, engagement per Short and per category, plus what the AI has learned.

## AI editing (hook, smart captions, sound effects)

Before each render an AI edit plan is made (Gemini, text only — cheap; a simple fallback without a key):
* **Hook banner** — a 3–6 word curiosity hook shown big at the top for the first ~3 s.
* **Smart captions** — fixes Whisper mistakes (game names, slang), drops filler words, picks highlight words.
* **Sound effects** — a few well-placed cues (whoosh on the hook, boom on a crash, ding on a realisation…).
  Built-ins (whoosh, boom, ding, riser, pop) are generated automatically. Add your own royalty-free sounds to
  `D:\clipforge-data\sfx\<type>\` (e.g. `laugh\`, `airhorn\`) and the AI starts using those types.
Everything is editable per clip in **Clip Studio → AI edit**, and can be switched off globally in **Settings → AI editing**.

## Missions & mission Shorts

Gemini labels every analysed minute with the mission/activity being played (it reuses the previous name while the
same mission continues). **Missions** lists them with their moments; tick 2–6 moments and **Create mission Short** to
render them as one Short (each part reframed + captioned, whoosh on every cut, AI hook/title from watching the whole
montage, intro/outro once). Nothing is rendered automatically unless *Auto-generate clips* is on in Settings.

## AI providers: Ollama (local) + Gemini

Two jobs, each with a preferred provider (Settings → AI moment detection) and automatic fallback to the other:
* **Finding moments** (every analysed minute) — default **Ollama** on your PC (free, no quota). Default model
  `qwen2.5vl:3b`; the app sends one contact-sheet image (6 frames) + the Whisper transcript + audio spikes.
  Ollama must be running on Windows; the containers reach it at `http://host.docker.internal:11434`.
  Bigger vision models (e.g. a 7B Qwen-VL) give better titles if your GPU has the memory.
* **Hooks / titles / caption clean-up** (only clips you render) — default **Gemini**, which watches the actual clip.

## Gemini quota

Free-tier keys run out quickly when analysing a live stream every minute. ClipBit (a) skips quiet minutes,
(b) sends video at low media resolution, (c) on "quota exceeded" waits and retries the minute later instead of producing
placeholder clips. For continuous streams, enabling billing on the Google AI Studio project is recommended
(Flash models are inexpensive; check current pricing in AI Studio).

## Intro & outro

**Settings → Intro & outro**: upload a short intro and/or outro video (any shape — horizontal ones get a blurred vertical
fill, max 30 s; 2–5 s works best). They're added to every new render in the same encode, and can be toggled per clip in
**Clip Studio → Trim & framing**. Files are kept in `D:\clipforge-data\branding\`. Existing clips change only when re-rendered.

## How moment detection works

* **Signals (always on):** per‑second momentary loudness (EBU R128) vs. the streamer's own rolling baseline, on‑screen
  motion energy, and speech energy (speaking rate + hype phrases like "no way", "let's go", laughter).
* **Gemini (with key):** each chunk is sent as a small 360p/2 fps proxy with audio, together with the timestamped
  transcript, the detected spikes, your preferred styles and a learning summary (approval rate per category, approved and
  rejected examples, top‑performing published Shorts). Gemini returns structured moments with scores and metadata.
  If a Gemini call fails the heuristic is used for that chunk.
* **Boundaries:** clip edges snap to sentence starts/ends, keep a 3–10 s lead‑in and a reaction tail, and are clamped to
  your min/max length with the peak ~60 % of the way through.
* **Learning:** approvals, rejections (with reasons) and YouTube performance re‑weight scores and are fed back into
  every Gemini prompt. Stats refresh every 6 h (or *Refresh* in Analytics).

## Configuration

Everything about detection, framing, captions, quality and publishing is in **Settings** (stored in Postgres).
Per‑stream framing and the facecam rectangle are under a stream's **Options**. Environment variables (`.env`):

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Multimodal analysis (default `gemini-2.5-flash`; any newer Gemini model id works) |
| `WHISPER_MODEL` | `tiny`/`base`/`small`/`medium`/`large-v3` (default `small`, CPU int8) |
| `WHISPER_DEVICE=cuda`, `WHISPER_COMPUTE_TYPE=float16` | GPU transcription (needs NVIDIA Container Toolkit + a `gpus: all` entry for the whisper service) |
| `ANALYZE_CONCURRENCY`, `RENDER_CONCURRENCY` | Worker parallelism. Raise render concurrency on a strong CPU |
| `STORAGE_DRIVER=s3` + `S3_*` | Store finished clips in any S3‑compatible bucket (AWS, R2, MinIO) |
| `APP_PASSWORD` | Protect the dashboard with HTTP basic auth (user `admin`) |
| `YTDLP_EXTRA_ARGS` | Extra yt-dlp flags if ever needed |

Storage: recordings and finished Shorts are saved to `D:\clipforge-data` (change `DATA_PATH` in `.env`).
Disk: a 1080p live stream records ~2–3 GB/hour. Raw chunks are deleted after `Keep raw recordings` hours (default 48);
finished clips are kept.

## Architecture

```
server/                 Node.js + TypeScript
  src/server.ts         Fastify REST API + serves the React dashboard
  src/worker.ts         BullMQ workers + live recorder supervisor (Redis leader lock)
  src/workers/          recorder · ingest · analyze · render · upload · maintenance
  src/services/ai/      signals, heuristic, Gemini REST client, Whisper client, boundaries
  src/services/video/   ffmpeg helpers, smart reframe, ASS captions, dead‑air, renderer
  src/services/youtube/ OAuth 2.0 + Data API client
  src/db/migrations/    PostgreSQL schema
  scripts/pipeline-test.ts   offline end‑to‑end video test (no DB/keys needed)
web/                    React + TypeScript (Vite), no UI framework
whisper/                faster-whisper microservice (FastAPI)
docker-compose.yml      postgres · redis · whisper · app · worker
```

Queues: `ingest` (VOD/file → chunks), `analyze` (chunk → moments), `render` (clip → Short), `upload` (→ YouTube),
`maintenance` (stats every 6 h, cleanup hourly). Every job retries with backoff; renders for live moments wait for the
next chunk if the moment runs past what's recorded so far.

## Development without Docker for the app

```bash
docker compose up -d postgres redis whisper     # infra only (expose ports or run them locally)
cd server && npm install && npm run dev:api     # http://localhost:8080
cd server && npm run dev:worker
cd web && npm install && npm run dev            # http://localhost:5173 (proxies /api)
```
Requires ffmpeg and yt-dlp on PATH. Offline video pipeline test on any file:
`cd server && npx tsx scripts/pipeline-test.ts my-recording.mp4 ./out`

## Legal & platform rules

* Only process streams/videos **you own or have explicit permission** to clip and republish — the app requires that
  confirmation for every source. Respect YouTube's Terms of Service, copyright and creators' wishes.
* No DRM, paywall, members‑only, private or age‑gate bypassing is implemented; such sources simply fail.
* Nothing is uploaded without your explicit approval of that exact clip (enforced by the API *and* the upload worker).
* YouTube OAuth tokens are encrypted at rest (AES‑256‑GCM with `APP_SECRET`) and revoked on disconnect.
* Game footage: check the publisher's video policy (Rockstar generally allows gameplay videos, with restrictions).

## Troubleshooting

* **Stream shows "error: Sign in to confirm you're not a bot"** — YouTube is rate‑limiting your IP for yt-dlp. Wait, or
  update yt-dlp: `docker compose build --no-cache app worker`.
* **No captions** — the Whisper container downloads its model on first use (Settings shows *Whisper ready* when it's up).
  Check `docker compose logs whisper`.
* **Renders slow** — use `Encoder speed: superfast`, lower `RENDER_CONCURRENCY` competition, or `blur`/`center` framing.
* **Logs:** `docker compose logs -f worker` (pipeline) and `docker compose logs -f app` (API).
