import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { one, q } from '../db/pool.js';
import { bad, HttpError, notFound, sendLocalFile, sendMedia } from '../lib/http.js';
import { errMsg } from '../lib/log.js';
import { storage } from '../lib/storage.js';
import { queues, queueCounts } from '../queues.js';
import { getAiHealth, getSettings, saveSettings } from '../settings.js';
import { classifyUrl, getInfo, ytdlpVersion } from '../services/ingest/ytdlp.js';
import { cleanOrphans, createClipFromMoment, deleteClips, normalizeTag, orphanReport, requeueRender, sessionTranscript } from '../services/clips.js';
import { renderSourcePreview } from '../services/video/render.js';
import { listSfx } from '../services/video/sfx.js';
import { brandingDir, type BrandSlot } from '../services/video/branding.js';
import { probe } from '../lib/proc.js';
import { activeGeminiModel, geminiEnabled, rewriteMetadata } from '../services/ai/gemini.js';
import { whisperStatus } from '../services/ai/transcribe.js';
import { ollamaStatus } from '../services/ai/ollama.js';
import { anyProviderAvailable, generateJson } from '../services/ai/providers.js';
import { getLearningProfile, invalidateLearningProfile } from '../services/learning.js';
import { buildChatPrompt, chatFrameSheet, enhancePublishMetadata, type PublishContext } from '../services/ai/publishmeta.js';
import { deleteSavedRecording, deleteStreamRecordings, requestSaveRecording } from '../services/recordings.js';
import { authUrl, disconnect, getAccount, handleCallback, youtubeConfigured } from '../services/youtube/client.js';
import { randomToken } from '../lib/crypto.js';

type Req<B = any, Q = any, P = { id: string }> = FastifyRequest & { body: B; query: Q; params: P };

const UUID = /^[0-9a-f-]{36}$/i;
const idOf = (req: Req) => {
  if (!UUID.test(req.params.id)) throw notFound();
  return req.params.id;
};
const oauthStates = new Map<string, number>();
const b0 = (req: any) => req.body || {};

export async function apiRoutes(app: FastifyInstance) {
  // ---------- system / dashboard ----------
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/system', async () => {
    const [whisperSt, ollamaSt, ytdlp, account, counts] = await Promise.all([whisperStatus(), ollamaStatus(true), ytdlpVersion(), getAccount(), queueCounts().catch(() => ({}))]);
    const s = await getSettings();
    return {
      gemini: geminiEnabled(),
      geminiModel: s.geminiModel || activeGeminiModel(),
      geminiHealth: await getAiHealth().catch(() => null),
      whisper: whisperSt.ready,
      whisperStatus: whisperSt,
      ollama: ollamaSt,
      aiProvider: s.aiProvider,
      ytdlp,
      youtubeConfigured: youtubeConfigured(),
      youtubeAccount: account ? { id: account.id, title: account.channel_title, thumbnail: account.thumbnail, channelId: account.channel_id } : null,
      storage: config.storage.driver,
      queues: counts,
    };
  });

  app.get('/api/dashboard', async () => {
    const [streams, moments, clips, pubs, recentMoments, recentClips, counts] = await Promise.all([
      q(`SELECT status, count(*)::int AS n FROM streams GROUP BY status`),
      one(`SELECT count(*)::int AS total, count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS today, COALESCE(round(avg(score)),0)::int AS avg_score FROM moments`),
      q(`SELECT status, count(*)::int AS n FROM clips GROUP BY status`),
      one(`SELECT count(*) FILTER (WHERE status IN ('published','scheduled'))::int AS published, count(*) FILTER (WHERE status IN ('queued','uploading'))::int AS pending,
                  COALESCE(sum((stats->>'views')::bigint),0)::bigint AS views FROM publications`),
      q(`SELECT m.id, m.title, m.score, m.category, m.created_at, s.name AS stream_name, m.status FROM moments m JOIN streams s ON s.id = m.stream_id ORDER BY m.created_at DESC LIMIT 6`),
      q(`SELECT c.id, c.title, c.status, c.score, c.duration, c.thumb_key IS NOT NULL AS has_thumb, c.created_at, s.name AS stream_name FROM clips c LEFT JOIN streams s ON s.id = c.stream_id ORDER BY c.created_at DESC LIMIT 8`),
      queueCounts().catch(() => ({})),
    ]);
    return {
      streams: Object.fromEntries(streams.map((r: any) => [r.status, r.n])),
      moments,
      clips: Object.fromEntries(clips.map((r: any) => [r.status, r.n])),
      publications: { ...pubs, views: Number(pubs?.views || 0) },
      recentMoments,
      recentClips,
      queues: counts,
    };
  });

  // ---------- streams ----------
  app.get('/api/streams', async () =>
    q(`SELECT s.*,
         (SELECT count(*) FROM chunks c WHERE c.stream_id = s.id)::int AS chunk_count,
         (SELECT count(*) FROM chunks c WHERE c.stream_id = s.id AND c.status IN ('pending','analyzing'))::int AS pending_chunks,
         (SELECT COALESCE(sum(c.end_sec - c.start_sec),0) FROM chunks c WHERE c.stream_id = s.id)::float AS recorded_seconds,
         (SELECT count(*) FROM moments m WHERE m.stream_id = s.id)::int AS moment_count,
         (SELECT count(*) FROM clips cl WHERE cl.stream_id = s.id)::int AS clip_count,
         (SELECT max(se.started_at) FROM sessions se WHERE se.stream_id = s.id AND se.active) AS live_since
       FROM streams s ORDER BY s.created_at DESC`));

  app.post('/api/streams', async (req: Req<{ url: string; name?: string; kind?: string; permissionConfirmed?: boolean; options?: any }>) => {
    const { url, name, permissionConfirmed } = req.body || ({} as any);
    if (!permissionConfirmed) throw bad('Please confirm you own this stream or have permission to clip and republish it.');
    if (!url) throw bad('url is required');
    const cls = classifyUrl(url.trim());
    if (cls === 'invalid') throw bad('Enter a YouTube video, live or channel URL (youtube.com/watch?v=…, youtube.com/@channel, youtu.be/…)');

    let kind = req.body.kind && req.body.kind !== 'auto' ? req.body.kind : cls === 'channel' ? 'channel' : '';
    let title = '';
    if (!kind) {
      try {
        const info = await getInfo(url.trim());
        title = info.title;
        kind = info.isLive || info.upcoming ? 'live' : 'vod';
      } catch (e) {
        throw bad(`Couldn't read that video: ${errMsg(e)}`);
      }
    }
    if (!['live', 'channel', 'vod'].includes(kind)) throw bad('invalid kind');
    const row = await one(
      `INSERT INTO streams (name, url, kind, status, permission_confirmed, source_title, options, next_check_at)
       VALUES ($1,$2,$3,$4,true,$5,$6, now()) RETURNING *`,
      [name?.trim() || title || url, url.trim(), kind, kind === 'vod' ? 'processing' : 'offline', title || null, JSON.stringify(req.body.options || {})],
    );
    if (kind === 'vod') await queues.ingest.add('ingest', { streamId: row.id }, { jobId: `ingest-${row.id}-1` });
    return row;
  });

  // raw file upload (application/octet-stream) of a recording you own
  app.post('/api/streams/upload', async (req: Req<NodeJS.ReadableStream, { name?: string; filename?: string; permission?: string }>) => {
    if (req.query.permission !== '1') throw bad('Please confirm you own this recording or have permission to use it.');
    const ext = (path.extname(req.query.filename || '') || '.mp4').toLowerCase();
    if (!['.mp4', '.mkv', '.mov', '.webm', '.ts', '.flv', '.avi'].includes(ext)) throw bad('unsupported file type');
    await fsp.mkdir(config.dirs.uploads, { recursive: true });
    const dest = path.join(config.dirs.uploads, `${crypto.randomUUID()}${ext}`);
    await pipeline(req.body, fs.createWriteStream(dest));
    const size = (await fsp.stat(dest)).size;
    if (size < 1000) {
      await fsp.rm(dest, { force: true });
      throw bad('upload was empty');
    }
    const name = req.query.name || req.query.filename || 'Uploaded recording';
    const row = await one(
      `INSERT INTO streams (name, url, kind, status, permission_confirmed, source_title, options) VALUES ($1, NULL, 'file', 'processing', true, $2, $3) RETURNING *`,
      [name, req.query.filename || name, JSON.stringify({ uploadPath: dest })],
    );
    await queues.ingest.add('ingest', { streamId: row.id }, { jobId: `ingest-${row.id}-1` });
    return row;
  });

  app.patch('/api/streams/:id', async (req: Req<{ paused?: boolean; name?: string; options?: any }>) => {
    const id = idOf(req);
    const s = await one(`SELECT * FROM streams WHERE id = $1`, [id]);
    if (!s) throw notFound();
    const b = req.body || {};
    if (b.name !== undefined) await q(`UPDATE streams SET name = $2 WHERE id = $1`, [id, String(b.name).slice(0, 200)]);
    if (b.options !== undefined) await q(`UPDATE streams SET options = options || $2::jsonb WHERE id = $1`, [id, JSON.stringify(b.options)]);
    if (b.paused !== undefined) {
      if (b.paused) await q(`UPDATE streams SET paused = true WHERE id = $1`, [id]);
      else await q(`UPDATE streams SET paused = false, status = CASE WHEN status = 'paused' THEN 'offline' ELSE status END, next_check_at = now(), fail_count = 0 WHERE id = $1`, [id]);
    }
    await q(`UPDATE streams SET updated_at = now() WHERE id = $1`, [id]);
    return one(`SELECT * FROM streams WHERE id = $1`, [id]);
  });

  app.post('/api/streams/:id/retry', async (req: Req) => {
    const id = idOf(req);
    const s = await one(`SELECT * FROM streams WHERE id = $1`, [id]);
    if (!s) throw notFound();
    if (s.kind === 'vod' || s.kind === 'file') {
      if (s.kind === 'file' && !fs.existsSync(s.options?.uploadPath || '')) {
        // file already segmented: re-analyse failed chunks instead
      } else {
        await queues.ingest.add('ingest', { streamId: id }, { jobId: `ingest-${id}-${Date.now()}` });
      }
    }
    const failed = await q<{ id: string }>(`UPDATE chunks SET status = 'pending', error = NULL WHERE stream_id = $1 AND status = 'failed' RETURNING id`, [id]);
    for (const c of failed) await queues.analyze.add('analyze', { chunkId: c.id }, { jobId: `analyze-${c.id}-${Date.now()}` });
    await q(`UPDATE streams SET next_check_at = now(), fail_count = 0, last_error = NULL, status = CASE WHEN status = 'error' THEN 'offline' ELSE status END WHERE id = $1`, [id]);
    return { ok: true, requeuedChunks: failed.length };
  });

  /** Throw away un-reviewed moments/clips and analyse the recorded footage again (e.g. after adding a Gemini key). */
  app.post('/api/streams/:id/reanalyze', async (req: Req) => {
    const id = idOf(req);
    const keep = await q<{ id: string }>(`SELECT DISTINCT moment_id AS id FROM clips WHERE stream_id = $1 AND moment_id IS NOT NULL AND status IN ('approved','published')`, [id]);
    const keepIds = keep.map((k) => k.id);
    const dropped = await q<{ file_key: string | null; thumb_key: string | null }>(
      `DELETE FROM clips WHERE stream_id = $1 AND status IN ('queued','rendering','ready','failed','rejected') RETURNING file_key, thumb_key`, [id]);
    for (const c of dropped) {
      if (c.file_key) await storage.remove(c.file_key).catch(() => {});
      if (c.thumb_key) await storage.remove(c.thumb_key).catch(() => {});
    }
    await q(`DELETE FROM moments WHERE stream_id = $1 AND NOT (id = ANY($2::uuid[]))`, [id, keepIds]);
    const chunks = await q<{ id: string }>(`UPDATE chunks SET status = 'pending', error = NULL WHERE stream_id = $1 AND status IN ('analyzed','failed') RETURNING id`, [id]);
    for (const c of chunks) await queues.analyze.add('analyze', { chunkId: c.id }, { jobId: `analyze-${c.id}-${Date.now()}` });
    return { ok: true, chunks: chunks.length, removedClips: dropped.length };
  });

  app.delete('/api/streams/:id', async (req: Req) => {
    const id = idOf(req);
    await q(`UPDATE streams SET paused = true WHERE id = $1`, [id]);
    const dir = path.join(config.dirs.recordings, id);
    // give the recorder a moment to stop, then remove raw recordings + saved full recordings (rendered clips are kept)
    setTimeout(() => {
      void q(`DELETE FROM streams WHERE id = $1`, [id])
        .then(() => Promise.all([fsp.rm(dir, { recursive: true, force: true }), deleteStreamRecordings(id)]))
        .catch(() => {});
    }, 12_000);
    return { ok: true };
  });

  // ---------- saved full recordings (one MP4 per recording session) ----------
  app.get('/api/streams/:id/recordings', async (req: Req) =>
    q(`SELECT se.id, se.title, se.active, se.started_at, se.ended_at, se.recording_status, se.recording_bytes, se.recording_duration,
              se.recording_error, se.recording_saved_at,
              (SELECT count(*)::int FROM chunks c WHERE c.session_id = se.id) AS chunk_count,
              (SELECT count(*)::int FROM chunks c WHERE c.session_id = se.id AND c.status <> 'purged') AS chunks_available,
              (SELECT COALESCE(max(c.end_sec), 0) FROM chunks c WHERE c.session_id = se.id) AS recorded_seconds
         FROM sessions se WHERE se.stream_id = $1 ORDER BY se.started_at DESC LIMIT 50`, [idOf(req)]));

  // "Save as video" for a past session (also re-tries a failed save)
  app.post('/api/sessions/:id/save-recording', async (req: Req) => {
    const se = await one(`SELECT active, (SELECT count(*)::int FROM chunks c WHERE c.session_id = sessions.id AND c.status <> 'purged') AS available FROM sessions WHERE id = $1`, [idOf(req)]);
    if (!se) throw notFound();
    if (se.active) throw bad('Still recording — it is saved automatically when the stream ends (if the option is on), or press Save after it ends.');
    if (!se.available) throw bad('The raw video pieces of this recording were already deleted (Settings → Keep raw recordings), so it can’t be saved any more.');
    return { ok: true, queued: await requestSaveRecording(idOf(req)) };
  });

  app.get('/api/sessions/:id/recording.mp4', async (req: Req, reply) => {
    const se = await one(
      `SELECT se.id, se.recording_key, se.started_at, se.title, st.name, st.source_title FROM sessions se JOIN streams st ON st.id = se.stream_id WHERE se.id = $1`,
      [idOf(req)],
    );
    if (!se?.recording_key) throw notFound('this recording has not been saved');
    // "Missions Robberies Gang Wars in GTA 6 2026-11-21 72e3ae3e.mp4" — the YouTube title beats a stream name that is
    // just the URL; ASCII only (HTTP headers can't carry emoji); short id keeps several sessions per day apart
    const ascii = (s: unknown) => String(s || '').normalize('NFKD').replace(/[^A-Za-z0-9 _-]+/g, ' ').replace(/\s+/g, ' ').trim();
    const named = [se.title, se.source_title, se.name]
      .map((s) => ascii(s).replace(/\s*\d{4}-\d{2}-\d{2}(\s+\d{2}\s?\d{2})?$/, '')) // live titles end with "2026-11-21 09:49"
      .find((s) => s && !/^https?\b|youtube com|www /i.test(s)) || 'recording';
    const name = `${named.slice(0, 70).trim()} ${new Date(se.started_at).toISOString().slice(0, 10)} ${String(se.id).slice(0, 8)}.mp4`;
    return sendMedia(req, reply, se.recording_key, 'video/mp4', (req.query as any)?.inline ? undefined : name);
  });

  app.delete('/api/sessions/:id/recording', async (req: Req) => {
    await deleteSavedRecording(idOf(req));
    return { ok: true };
  });

  // ---------- moments ----------
  app.get('/api/moments', async (req: Req<unknown, { streamId?: string; minScore?: string; status?: string; category?: string; limit?: string; offset?: string; sort?: string }>) => {
    const w: string[] = [];
    const p: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      p.push(v);
      w.push(sql.replace('?', `$${p.length}`));
    };
    if (req.query.streamId && UUID.test(req.query.streamId)) add('m.stream_id = ?', req.query.streamId);
    if (req.query.minScore) add('m.score >= ?', Number(req.query.minScore) || 0);
    if (req.query.status) add('m.status = ?', req.query.status);
    if (req.query.category) add('m.category = ?', req.query.category);
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const offset = Number(req.query.offset) || 0;
    const order = req.query.sort === 'score' ? 'm.score DESC, m.created_at DESC' : 'm.created_at DESC';
    const rows = await q(
      `SELECT m.*, s.name AS stream_name, s.url AS stream_url, se.title AS session_title,
              (SELECT c.id FROM clips c WHERE c.moment_id = m.id ORDER BY c.created_at DESC LIMIT 1) AS clip_id,
              (SELECT c.status FROM clips c WHERE c.moment_id = m.id ORDER BY c.created_at DESC LIMIT 1) AS clip_status
         FROM moments m JOIN streams s ON s.id = m.stream_id JOIN sessions se ON se.id = m.session_id
        ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
      p,
    );
    const total = await one(`SELECT count(*)::int AS n FROM moments m ${w.length ? 'WHERE ' + w.join(' AND ') : ''}`, p);
    return { items: rows, total: total?.n || 0 };
  });

  // ---------- the owner's own ratings (1-5 ★, null clears) — teach the scorer what they like ----------
  const starsOf = (b: any): number | null => {
    if (b?.stars === null || b?.stars === 0) return null;
    const n = Math.round(Number(b?.stars));
    if (!(n >= 1 && n <= 5)) throw bad('stars must be 1-5 (or null to clear)');
    return n;
  };
  app.post('/api/moments/:id/rating', async (req: Req<{ stars: number | null }>) => {
    const stars = starsOf(req.body);
    const row = await one(`UPDATE moments SET user_rating = $2 WHERE id = $1 RETURNING id`, [idOf(req), stars]);
    if (!row) throw notFound();
    invalidateLearningProfile();
    return { ok: true, stars };
  });
  app.post('/api/clips/:id/rating', async (req: Req<{ stars: number | null }>) => {
    const stars = starsOf(req.body);
    const row = await one<{ moment_id: string | null }>(`UPDATE clips SET user_rating = $2 WHERE id = $1 RETURNING moment_id`, [idOf(req), stars]);
    if (!row) throw notFound();
    // a clip rating is also a rating of its moment (single clips)
    if (row.moment_id) await q(`UPDATE moments SET user_rating = $2 WHERE id = $1`, [row.moment_id, stars]);
    invalidateLearningProfile();
    return { ok: true, stars };
  });

  app.post('/api/moments/:id/clip', async (req: Req) => {
    const clipId = await createClipFromMoment(idOf(req), await getSettings());
    return { clipId };
  });

  app.post('/api/moments/:id/dismiss', async (req: Req) => {
    await q(`UPDATE moments SET status = 'dismissed' WHERE id = $1`, [idOf(req)]);
    return { ok: true };
  });

  // ---------- missions ----------
  app.get('/api/missions', async (req: Req<unknown, { streamId?: string }>) => {
    const p: unknown[] = [];
    let where = `m.mission IS NOT NULL AND m.status <> 'dismissed'`;
    if (req.query.streamId && UUID.test(req.query.streamId)) {
      p.push(req.query.streamId);
      where += ` AND m.stream_id = $1`;
    }
    const rows = await q(
      `SELECT m.session_id, m.mission, s.name AS stream_name, se.title AS session_title, se.started_at,
              count(*)::int AS moment_count, min(m.start_sec) AS start_sec, max(m.end_sec) AS end_sec, max(m.score)::int AS best_score,
              json_agg(json_build_object('id', m.id, 'title', m.title, 'score', m.score, 'category', m.category,
                       'start_sec', m.start_sec, 'end_sec', m.end_sec, 'peak_sec', m.peak_sec, 'description', m.description) ORDER BY m.start_sec) AS moments,
              (SELECT json_agg(json_build_object('id', c.id, 'status', c.status, 'title', c.title, 'duration', c.duration) ORDER BY c.created_at DESC)
                 FROM clips c WHERE c.kind = 'mission' AND c.session_id = m.session_id AND c.options->>'mission' = m.mission) AS shorts
         FROM moments m JOIN streams s ON s.id = m.stream_id JOIN sessions se ON se.id = m.session_id
        WHERE ${where}
        GROUP BY m.session_id, m.mission, s.name, se.title, se.started_at
        ORDER BY se.started_at DESC, min(m.start_sec) DESC LIMIT 200`,
      p,
    );
    return rows;
  });

  /** Combine several moments of one mission into a single Short. Nothing renders until this is called. */
  app.post('/api/missions/compile', async (req: Req<{ momentIds: string[]; title?: string }>) => {
    const ids = (req.body?.momentIds || []).filter((x: string) => UUID.test(String(x)));
    if (ids.length < 2) throw bad('Pick at least 2 moments');
    const s = await getSettings();
    if (ids.length > s.missionShort.maxParts) throw bad(`Pick at most ${s.missionShort.maxParts} moments`);
    const ms = await q(`SELECT * FROM moments WHERE id = ANY($1::uuid[]) ORDER BY start_sec`, [ids]);
    if (ms.length !== ids.length) throw notFound('moment not found');
    if (new Set(ms.map((m: any) => m.session_id)).size > 1) throw bad('All moments must come from the same stream recording');
    // merge overlapping moments so footage isn't repeated
    const parts: { start: number; end: number; peak: number | null; momentIds: string[] }[] = [];
    for (const m of ms) {
      const last = parts[parts.length - 1];
      if (last && m.start_sec <= last.end + 1) {
        last.end = Math.max(last.end, m.end_sec);
        last.momentIds.push(m.id);
      } else parts.push({ start: m.start_sec, end: m.end_sec, peak: m.peak_sec, momentIds: [m.id] });
    }
    const total = parts.reduce((a, p) => a + (p.end - p.start), 0);
    if (total > s.missionShort.maxSeconds) throw bad(`That's ${Math.round(total)}s of footage — keep a mission Short under ${s.missionShort.maxSeconds}s (deselect a moment).`);
    const best = ms.reduce((a: any, b: any) => (b.score > a.score ? b : a));
    const mission = ms[0].mission || 'Mission';
    const tags = [...new Set([...ms.flatMap((m: any) => m.hashtags || []), ...s.publish.defaultHashtags].map(normalizeTag).filter(Boolean))].slice(0, 8);
    const clip = await one(
      `INSERT INTO clips (moment_id, stream_id, session_id, status, kind, parts, start_sec, end_sec, title, description, hashtags, score, category, options, version)
       VALUES ($1,$2,$3,'queued','mission',$4,$5,$6,$7,$8,$9,$10,$11,$12,1) RETURNING id`,
      [
        best.id, best.stream_id, best.session_id, JSON.stringify(parts), parts[0].start, parts[parts.length - 1].end,
        (req.body?.title || mission).slice(0, 100),
        ms.map((m: any) => m.description).filter(Boolean).join(' '),
        tags, Math.round(ms.reduce((a: number, m: any) => a + m.score, 0) / ms.length), best.category,
        JSON.stringify({
          mission,
          autoTitle: !req.body?.title,
          reframeMode: s.reframeMode,
          captions: s.captions.enabled,
          deadAir: s.deadAir.enabled,
          keywords: [...new Set(ms.flatMap((m: any) => m.keywords || []))].slice(0, 6),
        }),
      ],
    );
    await queues.render.add('render', { clipId: clip.id, version: 1 }, { jobId: `render-${clip.id}-1` });
    return { clipId: clip.id, parts: parts.length, seconds: Math.round(total) };
  });

  // ---------- clips ----------
  app.get('/api/clips', async (req: Req<unknown, { status?: string; limit?: string; streamId?: string }>) => {
    const statuses = (req.query.status || '').split(',').filter(Boolean);
    const p: unknown[] = [];
    const w: string[] = [];
    if (statuses.length) {
      p.push(statuses);
      w.push(`c.status = ANY($${p.length})`);
    }
    if (req.query.streamId && UUID.test(req.query.streamId)) {
      p.push(req.query.streamId);
      w.push(`c.stream_id = $${p.length}`);
    }
    return q(
      `SELECT c.id, c.status, c.title, c.description, c.hashtags, c.score, c.category, c.duration, c.start_sec, c.end_sec, c.progress, c.error,
              c.created_at, c.updated_at, c.approved_at, c.version, c.kind, c.thumb_key IS NOT NULL AS has_thumb, c.file_key IS NOT NULL AS has_video,
              s.name AS stream_name, s.url AS stream_url, c.user_rating,
              (SELECT m.score_breakdown FROM moments m WHERE m.id = c.moment_id) AS score_breakdown,
              (SELECT row_to_json(pp) FROM (SELECT id, status, progress, youtube_video_id, publish_at, error FROM publications WHERE clip_id = c.id ORDER BY created_at DESC LIMIT 1) pp) AS publication
         FROM clips c LEFT JOIN streams s ON s.id = c.stream_id
        ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY c.created_at DESC LIMIT ${Math.min(300, Number(req.query.limit) || 100)}`,
      p,
    );
  });

  app.get('/api/clips/:id', async (req: Req) => {
    const id = idOf(req);
    const clip = await one(
      `SELECT c.*, s.name AS stream_name, s.url AS stream_url, s.kind AS stream_kind, s.options AS stream_options, se.title AS session_title,
              m.peak_sec, m.transcript AS moment_transcript, m.detector, m.keywords, m.score_breakdown,
              (SELECT min(start_sec) FROM chunks WHERE session_id = c.session_id AND status <> 'purged') AS available_start,
              (SELECT max(end_sec) FROM chunks WHERE session_id = c.session_id AND status <> 'purged') AS available_end
         FROM clips c LEFT JOIN streams s ON s.id = c.stream_id LEFT JOIN sessions se ON se.id = c.session_id LEFT JOIN moments m ON m.id = c.moment_id
        WHERE c.id = $1`,
      [id],
    );
    if (!clip) throw notFound();
    clip.publications = await q(`SELECT * FROM publications WHERE clip_id = $1 ORDER BY created_at DESC`, [id]);
    return clip;
  });

  app.patch('/api/clips/:id', async (req: Req<{ title?: string; description?: string; hashtags?: string[] }>) => {
    const id = idOf(req);
    const b = req.body || {};
    if (b.title !== undefined && !String(b.title).trim()) throw bad('title cannot be empty');
    await q(
      `UPDATE clips SET title = COALESCE($2, title), description = COALESCE($3, description), hashtags = COALESCE($4, hashtags), updated_at = now() WHERE id = $1`,
      [id, b.title !== undefined ? String(b.title).slice(0, 100) : null, b.description ?? null, Array.isArray(b.hashtags) ? b.hashtags.map(normalizeTag).filter(Boolean).slice(0, 15) : null],
    );
    return one(`SELECT * FROM clips WHERE id = $1`, [id]);
  });

  app.post('/api/clips/:id/regenerate', async (req: Req<{ startSec?: number; endSec?: number; reframeMode?: string; captions?: boolean; deadAir?: boolean; captionSegments?: { start: number; end: number; text: string }[]; facecam?: any; refreshCaptions?: boolean; hook?: string; sfx?: { t: number; type: string }[]; hookEnabled?: boolean; sfxEnabled?: boolean; smartCaptions?: boolean; replanAi?: boolean; intro?: boolean; outro?: boolean }>) => {
    const id = idOf(req);
    const clip = await one(`SELECT * FROM clips WHERE id = $1`, [id]);
    if (!clip) throw notFound();
    if (clip.status === 'published') throw bad('This clip is already published. Duplicate it from the moment instead.');
    if (clip.kind === 'mission' && (b0(req).startSec !== undefined || b0(req).endSec !== undefined)) throw bad('Trim the parts of a mission Short by re-creating it from the Missions page');
    const s = await getSettings();
    const b = req.body || {};
    const start = b.startSec !== undefined ? Number(b.startSec) : clip.start_sec;
    const end = b.endSec !== undefined ? Number(b.endSec) : clip.end_sec;
    if (!(end > start)) throw bad('end must be after start');
    if (end - start < 3 || end - start > Math.max(s.clipMax, 60) + 0.01) throw bad(`clip length must be between 3 and ${Math.max(s.clipMax, 60)} seconds`);
    const avail = await one(`SELECT min(start_sec) AS a, max(end_sec) AS b FROM chunks WHERE session_id = $1 AND status <> 'purged'`, [clip.session_id]);
    if (avail?.a == null) throw bad('source recording is no longer available');
    if (start < avail.a - 0.01 || end > avail.b + 0.01) throw bad(`range must be within the recorded footage (${avail.a.toFixed(1)}–${avail.b.toFixed(1)}s)`);

    const options = { ...clip.options };
    if (b.reframeMode && ['smart', 'blur', 'center', 'split'].includes(b.reframeMode)) options.reframeMode = b.reframeMode;
    if (b.captions !== undefined) options.captions = !!b.captions;
    if (b.deadAir !== undefined) options.deadAir = !!b.deadAir;
    if (b.facecam !== undefined) options.facecam = b.facecam;
    if (b.hookEnabled !== undefined) options.hook = !!b.hookEnabled;
    if (b.sfxEnabled !== undefined) options.sfx = !!b.sfxEnabled;
    if (b.smartCaptions !== undefined) options.smartCaptions = !!b.smartCaptions;
    if (b.intro !== undefined) options.intro = !!b.intro;
    if (b.outro !== undefined) options.outro = !!b.outro;

    // AI edit plan: user overrides of hook / sfx are kept; replanAi asks the AI for a fresh plan
    let editPlan = clip.edit_plan;
    if (b.replanAi) editPlan = null;
    if (b.hook !== undefined || b.sfx !== undefined) {
      editPlan = {
        ...(editPlan || { keywords: [], sfx: [], hook: '' }),
        ...(b.hook !== undefined ? { hook: String(b.hook).slice(0, 80).toUpperCase() } : {}),
        ...(b.sfx !== undefined
          ? { sfx: b.sfx.filter((c: { t: number; type: string }) => Number.isFinite(c.t) && typeof c.type === 'string').slice(0, 10).map((c: { t: number; type: string }) => ({ t: Number(c.t), type: c.type.toLowerCase() })) }
          : {}),
        userEdited: true,
        source: 'user',
        forStart: start,
        forEnd: end,
        createdAt: new Date().toISOString(),
      };
    }

    let captions = clip.captions;
    const rangeChanged = start !== clip.start_sec || end !== clip.end_sec;
    if (b.captionSegments) {
      // user-edited captions: keep word timings where the text is unchanged
      const old: any[] = clip.captions?.segments || [];
      captions = {
        segments: b.captionSegments
          .filter((x: { start: number; end: number; text: string }) => x && typeof x.text === 'string' && Number.isFinite(x.start) && Number.isFinite(x.end))
          .map((x: { start: number; end: number; text: string }) => {
            const prev = old.find((o) => Math.abs(o.start - x.start) < 0.01 && Math.abs(o.end - x.end) < 0.01);
            return prev && prev.text.trim() === x.text.trim() ? prev : { start: x.start, end: x.end, text: x.text.trim() };
          }),
        edited: true,
      };
    } else if (rangeChanged || b.refreshCaptions || b.replanAi) {
      captions = { segments: await sessionTranscript(clip.session_id, start, end) };
    }
    await q(`UPDATE clips SET start_sec = $2, end_sec = $3, options = $4, captions = $5, edit_plan = $6 WHERE id = $1`, [
      id, start, end, JSON.stringify(options), JSON.stringify(captions), editPlan ? JSON.stringify(editPlan) : null,
    ]);
    const version = await requeueRender(id);
    return { ok: true, version };
  });

  app.post('/api/clips/:id/regenerate-metadata', async (req: Req) => {
    const id = idOf(req);
    if (!(await anyProviderAvailable())) throw bad('No AI available — add a GEMINI_API_KEY or start Ollama with a vision model');
    const clip = await one(`SELECT c.*, m.transcript AS mt FROM clips c LEFT JOIN moments m ON m.id = c.moment_id WHERE c.id = $1`, [id]);
    if (!clip) throw notFound();
    const s = await getSettings();
    const text = clip.mt || (clip.captions?.segments || []).map((x: any) => x.text).join(' ');
    const meta = await rewriteMetadata(
      { transcript: text, currentTitle: clip.title, context: s.contentContext, category: clip.category },
      async (parts, schema, t) => (await generateJson(parts.map((x: any) => x.text || '').join('\n'), null, schema, t, s.aiProvider.edit)).result,
    );
    return { title: String(meta.title || '').slice(0, 100), description: meta.description || '', hashtags: (meta.hashtags || []).map(normalizeTag).filter(Boolean) };
  });

  // ---------- Publish dialog: AI metadata help (only suggests — nothing is saved or uploaded until "Upload now") ----------
  type PublishBody = { title?: string; description?: string; hashtags?: string[]; prompt?: string };
  const publishContext = async (id: string, b: PublishBody = {}): Promise<PublishContext> => {
    const clip = await one(
      `SELECT c.*, m.transcript AS mt, m.description AS md, m.mission AS mm FROM clips c LEFT JOIN moments m ON m.id = c.moment_id WHERE c.id = $1`,
      [id],
    );
    if (!clip) throw notFound();
    const s = await getSettings();
    // mission Shorts have no single moment/captions: read speech + mission name from the recording, part by part
    const parts: { start: number; end: number; momentIds?: string[] }[] =
      Array.isArray(clip.parts) && clip.parts.length ? clip.parts : [{ start: clip.start_sec, end: clip.end_sec }];
    if (!clip.mt && !clip.captions?.segments?.length && clip.session_id) {
      const segs = (await Promise.all(parts.map((p) => sessionTranscript(clip.session_id, p.start, p.end).catch(() => [])))).flat();
      clip.mt = segs.map((x) => x.text.trim()).filter(Boolean).join(' ');
    }
    if (!clip.mm) {
      const ids = parts.flatMap((p) => p.momentIds || []);
      if (ids.length) clip.mm = (await one<{ mission: string }>(`SELECT mission FROM moments WHERE id = ANY($1::uuid[]) AND mission IS NOT NULL LIMIT 1`, [ids]))?.mission;
    }
    return {
      clip,
      draft: {
        title: String(b.title ?? clip.title ?? '').slice(0, 100),
        description: String(b.description ?? clip.description ?? '').slice(0, 2000),
        hashtags: (Array.isArray(b.hashtags) ? b.hashtags : clip.hashtags || []).map(String).slice(0, 15),
      },
      userPrompt: typeof b.prompt === 'string' ? b.prompt.slice(0, 500) : '',
      mission: clip.mm || null,
      momentDescription: clip.md,
      transcript: clip.mt,
      context: s.contentContext,
    };
  };

  // ✨ Enhance: the app's own free AI (Gemini free tier / local Ollama) watches the Short + follows the owner's direction
  app.post('/api/clips/:id/enhance-publish', async (req: Req<PublishBody>) => {
    if (!(await anyProviderAvailable())) throw bad('No AI available — add a GEMINI_API_KEY or start Ollama with a vision model');
    const ctx = await publishContext(idOf(req), req.body || {});
    const s = await getSettings();
    try {
      return await enhancePublishMetadata({ ...ctx, primary: s.aiProvider.edit });
    } catch (e) {
      throw bad(`AI enhance failed: ${errMsg(e).slice(0, 200)}`);
    }
  });

  // 📋 Copy for Claude/ChatGPT: a ready prompt for the owner's own chat app (no API / credits); answer is pasted back in the UI
  app.post('/api/clips/:id/publish-prompt', async (req: Req<PublishBody>) => buildChatPrompt(await publishContext(idOf(req), req.body || {})));

  // 🖼 the frame grid that goes with that prompt (drag it into the chat so Claude/ChatGPT can see the clip)
  app.get('/api/clips/:id/publish-frames.jpg', async (req: Req, reply) => {
    const ctx = await publishContext(idOf(req));
    const sheet = await chatFrameSheet(ctx.clip);
    if (!sheet) throw bad('Could not read this clip’s video to make frames');
    return reply
      .header('content-type', 'image/jpeg')
      .header('content-disposition', `attachment; filename="clipbit-frames-${ctx.clip.id.slice(0, 8)}.jpg"`)
      .header('cache-control', 'no-store')
      .send(sheet.jpeg);
  });

  app.post('/api/clips/:id/approve', async (req: Req) => {
    const id = idOf(req);
    const row = await one(`UPDATE clips SET status = 'approved', approved_at = now(), reject_reason = NULL, updated_at = now() WHERE id = $1 AND status IN ('ready','rejected') AND file_key IS NOT NULL RETURNING id`, [id]);
    if (!row) throw bad('Only rendered clips can be approved');
    return { ok: true };
  });

  app.post('/api/clips/:id/reject', async (req: Req<{ reason?: string }>) => {
    const id = idOf(req);
    const row = await one(`UPDATE clips SET status = 'rejected', approved_at = NULL, reject_reason = $2, updated_at = now() WHERE id = $1 AND status IN ('ready','approved','failed') RETURNING id`, [id, req.body?.reason?.slice(0, 300) || null]);
    if (!row) throw bad('This clip cannot be rejected in its current state');
    return { ok: true };
  });

  app.post('/api/clips/:id/unapprove', async (req: Req) => {
    await q(`UPDATE clips SET status = 'ready', approved_at = NULL, updated_at = now() WHERE id = $1 AND status = 'approved'`, [idOf(req)]);
    return { ok: true };
  });

  // single delete (Clip Studio editor) — same disk cleanup as bulk; allowed even while busy, as before
  app.delete('/api/clips/:id', async (req: Req) => ({ ok: true, ...(await deleteClips([idOf(req)], { allowBusy: true })) }));

  // leftover files of clips deleted earlier (no DB row any more): report + one-click cleanup in Clip Studio
  app.get('/api/storage/orphans', async () => orphanReport());
  app.post('/api/storage/orphans/clean', async () => cleanOrphans());

  // bulk delete (Clip Studio selection): removes rows + all files on disk; skips clips still rendering / uploading
  app.post('/api/clips/bulk-delete', async (req: Req<{ ids?: string[] }>) => {
    const ids = Array.isArray(req.body?.ids) ? req.body!.ids.map(String) : [];
    if (!ids.length) throw bad('No clips selected');
    if (ids.length > 500) throw bad('Delete at most 500 clips at a time');
    return deleteClips(ids);
  });

  app.get('/api/clips/:id/video', async (req: Req, reply) => {
    const clip = await one(`SELECT file_key FROM clips WHERE id = $1`, [idOf(req)]);
    if (!clip?.file_key) throw notFound('clip not rendered yet');
    return sendMedia(req, reply, clip.file_key, 'video/mp4');
  });

  app.get('/api/clips/:id/thumb', async (req: Req, reply) => {
    const clip = await one(`SELECT thumb_key FROM clips WHERE id = $1`, [idOf(req)]);
    if (!clip?.thumb_key) throw notFound();
    return sendMedia(req, reply, clip.thumb_key, 'image/jpeg');
  });

  app.get('/api/clips/:id/download', async (req: Req, reply) => {
    const clip = await one(`SELECT file_key, title FROM clips WHERE id = $1`, [idOf(req)]);
    if (!clip?.file_key) throw notFound('clip not rendered yet');
    const safe = String(clip.title).replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'clip';
    return sendMedia(req, reply, clip.file_key, 'video/mp4', `${safe}.mp4`);
  });

  /** Low-res preview of the original (16:9) footage for choosing trim points. */
  app.get('/api/clips/:id/source', async (req: Req<unknown, { from?: string; to?: string }>, reply) => {
    const id = idOf(req);
    const clip = await one(`SELECT session_id FROM clips WHERE id = $1`, [id]);
    if (!clip?.session_id) throw notFound();
    const from = Math.max(0, Number(req.query.from));
    const to = Number(req.query.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to - from < 1 || to - from > 240) throw bad('invalid range');
    const chunks = await q(`SELECT file, start_sec, end_sec FROM chunks WHERE session_id = $1 AND status <> 'purged' AND end_sec > $2 AND start_sec < $3 ORDER BY start_sec`, [clip.session_id, from, to]);
    if (!chunks.length) throw notFound('source footage no longer available');
    const realFrom = Math.max(from, chunks[0].start_sec);
    const realTo = Math.min(to, chunks[chunks.length - 1].end_sec);
    const file = path.join(config.dirs.cache, 'previews', `${clip.session_id}-${realFrom.toFixed(1)}-${realTo.toFixed(1)}.mp4`);
    if (!fs.existsSync(file)) {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await renderSourcePreview(chunks, realFrom, realTo, file + '.tmp.mp4');
      await fsp.rename(file + '.tmp.mp4', file);
    }
    reply.header('X-Source-From', String(realFrom)).header('X-Source-To', String(realTo));
    return sendLocalFile(req, reply, file, 'video/mp4');
  });

  // ---------- branding: intro / outro bumpers ----------
  const slotOf = (req: Req<any, any, { slot: string }>): BrandSlot => {
    if (req.params.slot !== 'intro' && req.params.slot !== 'outro') throw notFound();
    return req.params.slot;
  };

  app.get('/api/branding', async () => {
    const s = await getSettings();
    const out = [];
    for (const slot of ['intro', 'outro'] as BrandSlot[]) {
      const b = s.branding[slot];
      const file = b.file ? path.join(brandingDir(), path.basename(b.file)) : '';
      let meta: any = null;
      if (file && fs.existsSync(file)) meta = await probe(file).catch(() => null);
      out.push({ slot, enabled: b.enabled && !!meta, file: b.file, exists: !!meta, duration: meta?.duration ?? null, width: meta?.width ?? null, height: meta?.height ?? null, hasAudio: meta?.hasAudio ?? null, updatedAt: meta ? fs.statSync(file).mtimeMs : null });
    }
    return out;
  });

  app.post('/api/branding/:slot', async (req: Req<NodeJS.ReadableStream, { filename?: string }, { slot: string }>) => {
    const slot = slotOf(req);
    const ext = (path.extname(req.query.filename || '') || '.mp4').toLowerCase();
    if (!['.mp4', '.mov', '.mkv', '.webm', '.m4v'].includes(ext)) throw bad('Upload an mp4, mov, mkv or webm video');
    await fsp.mkdir(brandingDir(), { recursive: true });
    const tmp = path.join(brandingDir(), `${slot}.upload${ext}`);
    await pipeline(req.body, fs.createWriteStream(tmp));
    const meta = await probe(tmp).catch(() => null);
    if (!meta || !meta.width || !meta.duration) {
      await fsp.rm(tmp, { force: true });
      throw bad('That file is not a readable video');
    }
    if (meta.duration > 30) {
      await fsp.rm(tmp, { force: true });
      throw bad(`The ${slot} is ${meta.duration.toFixed(1)}s — keep it under 30s (2–5s works best for Shorts)`);
    }
    for (const f of await fsp.readdir(brandingDir())) if (f.startsWith(slot + '.') && !f.includes('.upload')) await fsp.rm(path.join(brandingDir(), f), { force: true });
    const name = `${slot}${ext}`;
    await fsp.rename(tmp, path.join(brandingDir(), name));
    await saveSettings({ branding: { [slot]: { enabled: true, file: name } } } as any);
    return { ok: true, duration: meta.duration };
  });

  app.patch('/api/branding/:slot', async (req: Req<{ enabled: boolean }, any, { slot: string }>) => {
    const slot = slotOf(req);
    await saveSettings({ branding: { [slot]: { enabled: !!req.body?.enabled } } } as any);
    return { ok: true };
  });

  app.delete('/api/branding/:slot', async (req: Req<any, any, { slot: string }>) => {
    const slot = slotOf(req);
    const s = await getSettings();
    if (s.branding[slot].file) await fsp.rm(path.join(brandingDir(), path.basename(s.branding[slot].file)), { force: true });
    await saveSettings({ branding: { [slot]: { enabled: false, file: '' } } } as any);
    return { ok: true };
  });

  app.get('/api/branding/:slot/video', async (req: Req<any, any, { slot: string }>, reply) => {
    const slot = slotOf(req);
    const s = await getSettings();
    const file = s.branding[slot].file ? path.join(brandingDir(), path.basename(s.branding[slot].file)) : '';
    if (!file || !fs.existsSync(file)) throw notFound();
    return sendLocalFile(req, reply, file, 'video/mp4');
  });

  app.get('/api/sfx', async () => {
    const lib = await listSfx().catch(() => ({} as Record<string, string[]>));
    return Object.entries(lib).map(([type, files]) => ({ type, files: files.length, builtin: files.every((f) => f.includes('_builtin')) }));
  });

  // ---------- publishing ----------
  app.post('/api/clips/:id/publish', async (req: Req<{ privacy?: string; publishAt?: string; title?: string; description?: string; hashtags?: string[] }>) => {
    const id = idOf(req);
    const clip = await one(`SELECT * FROM clips WHERE id = $1`, [id]);
    if (!clip) throw notFound();
    if (clip.status !== 'approved' || !clip.approved_at) throw bad('Approve the clip before publishing it.');
    const account = await getAccount();
    if (!account) throw bad('Connect your YouTube channel in Settings first.');
    const active = await one(`SELECT id FROM publications WHERE clip_id = $1 AND status IN ('queued','uploading','scheduled','published')`, [id]);
    if (active) throw bad('This clip is already queued or published.');
    const s = await getSettings();
    const privacy = ['public', 'unlisted', 'private'].includes(req.body?.privacy || '') ? req.body!.privacy! : s.publish.defaultPrivacy;
    let publishAt: Date | null = null;
    if (req.body?.publishAt) {
      publishAt = new Date(req.body.publishAt);
      if (Number.isNaN(publishAt.getTime())) throw bad('invalid schedule time');
      if (publishAt.getTime() < Date.now() + 5 * 60 * 1000) throw bad('schedule time must be at least 5 minutes in the future');
    }
    const title = (req.body?.title || clip.title).slice(0, 100);
    const tags = (req.body?.hashtags || clip.hashtags || []).map(normalizeTag).filter(Boolean);
    const pub = await one(
      `INSERT INTO publications (clip_id, account_id, status, privacy, publish_at, title, description, tags, approved_by_user_at)
       VALUES ($1,$2,'queued',$3,$4,$5,$6,$7,$8) RETURNING *`,
      [id, account.id, privacy, publishAt, title, req.body?.description ?? clip.description ?? '', tags, clip.approved_at],
    );
    await queues.upload.add('upload', { publicationId: pub.id }, { jobId: `upload-${pub.id}-0` });
    return pub;
  });

  app.get('/api/publications', async () =>
    q(`SELECT p.*, c.thumb_key IS NOT NULL AS has_thumb, c.duration, c.category, s.name AS stream_name
         FROM publications p JOIN clips c ON c.id = p.clip_id LEFT JOIN streams s ON s.id = c.stream_id
        ORDER BY p.created_at DESC LIMIT 300`));

  app.post('/api/publications/:id/retry', async (req: Req) => {
    const id = idOf(req);
    const pub = await one(`UPDATE publications SET status = 'queued', error = NULL, progress = 0, updated_at = now() WHERE id = $1 AND status = 'failed' RETURNING id`, [id]);
    if (!pub) throw bad('Only failed uploads can be retried');
    await queues.upload.add('upload', { publicationId: id }, { jobId: `upload-${id}-${Date.now()}` });
    return { ok: true };
  });

  app.delete('/api/publications/:id', async (req: Req) => {
    const row = await one(`DELETE FROM publications WHERE id = $1 AND status IN ('failed','queued') RETURNING id`, [idOf(req)]);
    if (!row) throw bad('Only queued or failed uploads can be removed (manage published videos in YouTube Studio)');
    return { ok: true };
  });

  // ---------- YouTube OAuth ----------
  app.get('/api/youtube/auth', async (_req, reply) => {
    if (!youtubeConfigured()) throw bad('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first');
    const state = randomToken(16);
    oauthStates.set(state, Date.now());
    for (const [k, t] of oauthStates) if (Date.now() - t > 15 * 60 * 1000) oauthStates.delete(k);
    return reply.redirect(authUrl(state));
  });

  app.get('/api/youtube/callback', async (req: Req<unknown, { code?: string; state?: string; error?: string }>, reply) => {
    const { code, state, error } = req.query;
    if (error) return reply.redirect(`/#/settings?yt=${encodeURIComponent(error)}`);
    if (!state || !oauthStates.has(state)) return reply.redirect('/#/settings?yt=invalid_state');
    oauthStates.delete(state);
    if (!code) return reply.redirect('/#/settings?yt=missing_code');
    try {
      await handleCallback(code);
      return reply.redirect('/#/settings?yt=connected');
    } catch (e) {
      return reply.redirect(`/#/settings?yt=${encodeURIComponent(errMsg(e).slice(0, 200))}`);
    }
  });

  app.post('/api/youtube/disconnect', async () => {
    const acct = await getAccount();
    if (acct) await disconnect(acct.id);
    return { ok: true };
  });

  // ---------- analytics ----------
  app.get('/api/analytics', async () => {
    const [published, byCategory, funnel, learning] = await Promise.all([
      q(`SELECT p.id, p.title, p.youtube_video_id, p.status, p.privacy, p.created_at, p.stats, p.stats_updated_at, c.category, c.score, c.duration, c.id AS clip_id
           FROM publications p JOIN clips c ON c.id = p.clip_id WHERE p.status IN ('published','scheduled') ORDER BY p.created_at DESC LIMIT 200`),
      q(`SELECT COALESCE(c.category,'other') AS category,
                count(*)::int AS clips,
                count(*) FILTER (WHERE c.status IN ('approved','published'))::int AS approved,
                count(*) FILTER (WHERE c.status = 'rejected')::int AS rejected,
                count(p.id) FILTER (WHERE p.status = 'published')::int AS published,
                COALESCE(avg((p.stats->>'views')::numeric),0)::float AS avg_views,
                COALESCE(avg((p.stats->>'avgViewPercentage')::numeric),0)::float AS avg_retention
           FROM clips c LEFT JOIN publications p ON p.clip_id = c.id GROUP BY 1 ORDER BY clips DESC`),
      one(`SELECT (SELECT count(*) FROM moments)::int AS moments, (SELECT count(*) FROM clips)::int AS clips,
                  (SELECT count(*) FROM clips WHERE status IN ('approved','published'))::int AS approved,
                  (SELECT count(*) FROM publications WHERE status IN ('published','scheduled'))::int AS published`),
      getLearningProfile(),
    ]);
    const totals = published.reduce(
      (a: any, p: any) => {
        a.views += Number(p.stats?.views || 0);
        a.likes += Number(p.stats?.likes || 0);
        a.comments += Number(p.stats?.comments || 0);
        return a;
      },
      { views: 0, likes: 0, comments: 0 },
    );
    return { published, byCategory, funnel, learning, totals };
  });

  app.post('/api/analytics/refresh', async () => {
    await queues.maintenance.add('stats', {}, { jobId: `stats-${Date.now()}` });
    return { ok: true };
  });

  // ---------- settings ----------
  app.get('/api/settings', async () => getSettings());
  app.put('/api/settings', async (req: Req<any>) => {
    const b = req.body || {};
    if (b.minScore !== undefined && (b.minScore < 0 || b.minScore > 100)) throw bad('minScore must be 0-100');
    return saveSettings(b);
  });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err.validation) return reply.code(400).send({ error: err.message });
    app.log.error(err);
    return reply.code(err.statusCode && err.statusCode < 600 ? err.statusCode : 500).send({ error: errMsg(err) });
  });
}
