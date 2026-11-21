import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { errMsg, logger } from '../lib/log.js';
import { diskSize, storage } from '../lib/storage.js';
import { one, q } from '../db/pool.js';
import { queues } from '../queues.js';
import type { AppSettings } from '../settings.js';
import type { Segment } from './ai/types.js';

const log = logger('clips');

export async function sessionTranscript(sessionId: string, start: number, end: number): Promise<Segment[]> {
  const rows = await q<{ transcript: Segment[] | null }>(
    `SELECT transcript FROM chunks WHERE session_id = $1 AND end_sec > $2 AND start_sec < $3 ORDER BY start_sec`,
    [sessionId, start, end],
  );
  const segs: Segment[] = [];
  for (const r of rows) for (const s of r.transcript || []) if (s.end > start && s.start < end) segs.push(s);
  // de-duplicate overlapping segments coming from neighbouring chunks
  return segs.sort((a, b) => a.start - b.start).filter((s, i, arr) => i === 0 || s.start >= arr[i - 1].end - 0.05 || s.text !== arr[i - 1].text);
}

export async function createClipFromMoment(momentId: string, settings: AppSettings) {
  const m = await one<any>(`SELECT m.*, s.options AS stream_options FROM moments m JOIN streams s ON s.id = m.stream_id WHERE m.id = $1`, [momentId]);
  if (!m) throw new Error('moment not found');
  const existing = await one<{ id: string }>(`SELECT id FROM clips WHERE moment_id = $1 AND status <> 'rejected' LIMIT 1`, [momentId]);
  if (existing) return existing.id;

  const captions = await sessionTranscript(m.session_id, m.start_sec, m.end_sec);
  const tags = [...new Set([...(m.hashtags || []), ...settings.publish.defaultHashtags].map(normalizeTag).filter(Boolean))].slice(0, 8);
  const clip = await one<{ id: string }>(
    `INSERT INTO clips (moment_id, stream_id, session_id, status, start_sec, end_sec, title, description, hashtags, score, category, captions, options, version)
     VALUES ($1,$2,$3,'queued',$4,$5,$6,$7,$8,$9,$10,$11,$12,1) RETURNING id`,
    [
      m.id, m.stream_id, m.session_id, m.start_sec, m.end_sec, m.title, m.description, tags, m.score, m.category,
      JSON.stringify({ segments: captions }),
      JSON.stringify({
        reframeMode: m.stream_options?.reframeMode || settings.reframeMode,
        captions: settings.captions.enabled,
        deadAir: settings.deadAir.enabled,
        keywords: m.keywords || [],
      }),
    ],
  );
  await q(`UPDATE moments SET status = 'clipped' WHERE id = $1`, [m.id]);
  await queues.render.add('render', { clipId: clip!.id, version: 1 }, { jobId: `render-${clip!.id}-1` });
  return clip!.id;
}

export function normalizeTag(t: string) {
  const s = String(t || '').trim().replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '');
  return s ? `#${s}` : '';
}

/** Bump version and queue a fresh render (stale jobs for older versions are ignored by the worker). */
export async function requeueRender(clipId: string) {
  const row = await one<{ version: number }>(
    `UPDATE clips SET version = version + 1, status = 'queued', progress = 0, error = NULL, approved_at = NULL, updated_at = now()
      WHERE id = $1 RETURNING version`,
    [clipId],
  );
  if (!row) throw new Error('clip not found');
  await queues.render.add('render', { clipId, version: row.version }, { jobId: `render-${clipId}-${row.version}` });
  return row.version;
}

export interface DeleteClipsResult {
  deleted: number;
  freedBytes: number;
  skipped: { id: string; title: string; reason: string }[];
}

/**
 * Permanently delete clips: the DB rows (publications cascade) AND every file on disk — all rendered versions
 * (media/clips/<id>/), thumbnails, and leftover work files (AI-plan / publish previews, half-finished renders).
 * Videos already on YouTube are NOT touched. Clips that are rendering or have an upload queued/in progress are
 * skipped unless `allowBusy` (the worker is still writing / reading their files).
 */
export async function deleteClips(ids: string[], opts: { allowBusy?: boolean } = {}): Promise<DeleteClipsResult> {
  const unique = [...new Set(ids.filter((x) => /^[0-9a-f-]{36}$/i.test(x)))];
  const res: DeleteClipsResult = { deleted: 0, freedBytes: 0, skipped: [] };
  if (!unique.length) return res;
  const rows = await q<{ id: string; title: string; status: string; file_key: string | null; thumb_key: string | null; uploading: boolean }>(
    `SELECT c.id, c.title, c.status, c.file_key, c.thumb_key,
            EXISTS (SELECT 1 FROM publications p WHERE p.clip_id = c.id AND p.status IN ('queued','uploading')) AS uploading
       FROM clips c WHERE c.id = ANY($1::uuid[])`,
    [unique],
  );
  const workEntries = await fs.readdir(config.dirs.work).catch(() => [] as string[]);
  for (const c of rows) {
    if (!opts.allowBusy && (c.status === 'rendering' || c.status === 'queued')) {
      res.skipped.push({ id: c.id, title: c.title, reason: 'still rendering' });
      continue;
    }
    if (!opts.allowBusy && c.uploading) {
      res.skipped.push({ id: c.id, title: c.title, reason: 'upload in progress' });
      continue;
    }
    const gone = await one(`DELETE FROM clips WHERE id = $1 RETURNING id`, [c.id]);
    if (!gone) continue;
    res.deleted++;
    // every version lives under clips/<id>/ ; also remove the exact keys in case an old clip used another layout
    for (const key of [c.file_key, c.thumb_key]) if (key && !key.startsWith(`clips/${c.id}/`)) await storage.remove(key).catch(() => {});
    res.freedBytes += await storage.removePrefix(`clips/${c.id}`).catch((e) => (log.warn(`could not remove files of clip ${c.id}: ${errMsg(e)}`), 0));
    for (const e of workEntries.filter((n) => n.includes(c.id))) {
      const p = path.join(config.dirs.work, e);
      res.freedBytes += await diskSize(p);
      await fs.rm(p, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (res.deleted) log.info(`deleted ${res.deleted} clip(s), freed ${(res.freedBytes / 1048576).toFixed(1)} MB${res.skipped.length ? `, skipped ${res.skipped.length}` : ''}`);
  return res;
}

export interface OrphanReport { count: number; bytes: number; supported: boolean }

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Files left on disk by clips that no longer exist in the database (deleted before disk cleanup existed, or with
 * their stream): media/clips/<clipId>/ folders and work/{plan,publish,render}-<clipId>* previews.
 * Only entries named after a clip id that is NOT in the clips table count — nothing else is ever touched.
 */
async function findOrphans(): Promise<{ paths: string[]; bytes: number }> {
  const known = new Set((await q<{ id: string }>(`SELECT id FROM clips`)).map((r) => r.id.toLowerCase()));
  const paths: string[] = [];
  const clipsDir = path.join(config.dirs.media, 'clips');
  for (const name of await fs.readdir(clipsDir).catch(() => [] as string[])) {
    if (/^[0-9a-f-]{36}$/i.test(name) && !known.has(name.toLowerCase())) paths.push(path.join(clipsDir, name));
  }
  for (const name of await fs.readdir(config.dirs.work).catch(() => [] as string[])) {
    const m = name.match(/^(plan|publish|render)-/) && name.match(UUID);
    if (m && !known.has(m[0].toLowerCase())) paths.push(path.join(config.dirs.work, name));
  }
  let bytes = 0;
  for (const p of paths) bytes += await diskSize(p);
  return { paths, bytes };
}

export async function orphanReport(): Promise<OrphanReport> {
  if (config.storage.driver === 's3') return { count: 0, bytes: 0, supported: false };
  const { paths, bytes } = await findOrphans();
  return { count: paths.length, bytes, supported: true };
}

/** Delete the orphaned files found by findOrphans() (re-scanned now, so a clip created meanwhile is never touched). */
export async function cleanOrphans(): Promise<{ deleted: number; freedBytes: number }> {
  if (config.storage.driver === 's3') return { deleted: 0, freedBytes: 0 };
  const { paths, bytes } = await findOrphans();
  const roots = [path.resolve(config.dirs.media, 'clips'), path.resolve(config.dirs.work)];
  let deleted = 0;
  for (const p of paths) {
    const abs = path.resolve(p);
    if (!roots.includes(path.dirname(abs))) continue; // only direct children of the two folders
    await fs.rm(abs, { recursive: true, force: true }).then(() => deleted++).catch((e) => log.warn(`could not remove ${abs}: ${errMsg(e)}`));
  }
  log.info(`orphan cleanup: removed ${deleted} entries, freed ${(bytes / 1048576).toFixed(1)} MB`);
  return { deleted, freedBytes: bytes };
}
