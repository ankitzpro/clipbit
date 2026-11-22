/** VOD (past broadcast / uploaded video you own) and local file import -> chunks -> analysis. */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Job } from 'bullmq';
import { config } from '../config.js';
import { one, q } from '../db/pool.js';
import { logger } from '../lib/log.js';
import type { IngestJob } from '../queues.js';
import { getSettings } from '../settings.js';
import { downloadVod, getInfo } from '../services/ingest/ytdlp.js';
import { segmentFile } from '../services/ingest/segment.js';
import { registerChunks } from './recorder.js';
import { onSessionEnded } from '../services/recordings.js';

const log = logger('ingest');
export class SwitchToLive extends Error {}

/** Import progress shown on the stream card (streams.ingest_progress). Throttled to one DB write per 3 s. */
function progressWriter(streamId: string) {
  let lastAt = 0;
  let lastPhase = '';
  return (p: { phase: string; pct?: number | null; doneSec?: number; totalSec?: number; speed?: number | null; note?: string }) => {
    const now = Date.now();
    if (p.phase === lastPhase && now - lastAt < 3000) return;
    lastAt = now;
    lastPhase = p.phase;
    const pct = p.pct ?? (p.totalSec ? Math.min(100, (100 * (p.doneSec || 0)) / p.totalSec) : null);
    const etaSec = p.speed && p.totalSec ? Math.max(0, Math.round((p.totalSec - (p.doneSec || 0)) / p.speed)) : null;
    void q(`UPDATE streams SET ingest_progress = $2 WHERE id = $1`, [streamId, JSON.stringify({ ...p, pct: pct == null ? null : Math.round(pct * 10) / 10, etaSec, at: new Date().toISOString() })]).catch(() => {});
  };
}

export async function processIngest(job: Job<IngestJob>) {
  const stream = await one<any>(`SELECT * FROM streams WHERE id = $1`, [job.data.streamId]);
  if (!stream) return;
  if (!stream.permission_confirmed) throw new Error('permission not confirmed for this stream');
  const settings = await getSettings();

  const session = await one<{ id: string }>(`INSERT INTO sessions (stream_id, dir, title) VALUES ($1,'',$2) RETURNING id`, [stream.id, stream.source_title || stream.name]);
  const dir = path.join(config.dirs.recordings, stream.id, session!.id);
  await fs.mkdir(dir, { recursive: true });
  await q(`UPDATE sessions SET dir = $2 WHERE id = $1`, [session!.id, dir]);
  await q(`UPDATE streams SET status = 'processing', last_error = NULL, updated_at = now() WHERE id = $1`, [stream.id]);

  try {
    await ingestInto(job, stream, session!.id, dir, settings.chunkSeconds);
  } catch (e) {
    await q(`UPDATE streams SET ingest_progress = NULL WHERE id = $1`, [stream.id]).catch(() => {});
    if (e instanceof SwitchToLive) {
      await q(`DELETE FROM sessions WHERE id = $1`, [session!.id]);
      return;
    }
    await q(`DELETE FROM sessions WHERE id = $1`, [session!.id]);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

async function ingestInto(job: Job<IngestJob>, stream: any, sessionId: string, dir: string, chunkSeconds: number) {
  const session = { id: sessionId };
  let source: string;
  let downloaded = false;
  const progress = progressWriter(stream.id);
  if (stream.kind === 'file') {
    // uploadPath = ClipBit's own copy of an upload; localPath = the owner's original on disk (read in place, never deleted)
    source = stream.options?.uploadPath || stream.options?.localPath;
    if (!source) throw new Error('uploaded file missing');
    if (!(await fs.stat(source).catch(() => null))) throw new Error(`video file not found: ${stream.options?.localName || source}`);
  } else {
    progress({ phase: 'checking', note: 'asking YouTube for the video' });
    const info = await getInfo(stream.url);
    if (info.isLive) {
      // it's actually live: switch to live recording mode
      await q(`UPDATE streams SET kind = 'live', status = 'offline', next_check_at = now() WHERE id = $1`, [stream.id]);
      throw new SwitchToLive();
    }
    await q(`UPDATE streams SET source_title = $2 WHERE id = $1`, [stream.id, info.title]);
    // real-audience signal for scoring, when YouTube has a "Most replayed" graph for this video
    if (info.heatmap?.length) await q(`UPDATE sessions SET heatmap = $2 WHERE id = $1`, [sessionId, JSON.stringify(info.heatmap)]);
    let last = 0;
    source = await downloadVod(stream.url, path.join(dir, 'source'), (pct) => {
      progress({ phase: 'downloading', pct });
      if (pct - last >= 5) {
        last = pct;
        void job.updateProgress(Math.round(pct * 0.8));
      }
    });
    downloaded = true;
  }

  log.info(`segmenting ${source}`);
  // register finished pieces every few seconds so analysis (GPU) runs while the conversion (CPU) is still going
  const seen = new Set<number>();
  let early = 0;
  await segmentFile(source, dir, chunkSeconds, {
    onProgress: (p) => progress(p),
    onTick: async () => { early += await registerChunks(session.id, stream.id, dir, seen); },
  });
  await q(`UPDATE sessions SET active = false, ended_at = now() WHERE id = $1`, [session.id]);
  const n = early + (await registerChunks(session.id, stream.id, dir, seen));
  await q(`UPDATE streams SET ingest_progress = NULL WHERE id = $1`, [stream.id]);
  await onSessionEnded(session.id); // "Save the full recording" → join the chunks into one MP4
  if (downloaded) await fs.rm(source, { force: true });
  // only delete ClipBit's own upload copy — never a local original (it's also mounted read-only)
  if (stream.kind === 'file' && stream.options?.uploadPath && !stream.options?.localPath) await fs.rm(source, { force: true }).catch(() => {});
  log.info(`queued ${n} chunks for analysis (${stream.name})`);
  await job.updateProgress(100);
}
