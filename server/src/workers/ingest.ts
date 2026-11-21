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
  if (stream.kind === 'file') {
    source = stream.options?.uploadPath;
    if (!source) throw new Error('uploaded file missing');
  } else {
    const info = await getInfo(stream.url);
    if (info.isLive) {
      // it's actually live: switch to live recording mode
      await q(`UPDATE streams SET kind = 'live', status = 'offline', next_check_at = now() WHERE id = $1`, [stream.id]);
      throw new SwitchToLive();
    }
    await q(`UPDATE streams SET source_title = $2 WHERE id = $1`, [stream.id, info.title]);
    let last = 0;
    source = await downloadVod(stream.url, path.join(dir, 'source'), (pct) => {
      if (pct - last >= 5) {
        last = pct;
        void job.updateProgress(Math.round(pct * 0.8));
      }
    });
    downloaded = true;
  }

  log.info(`segmenting ${source}`);
  await segmentFile(source, dir, chunkSeconds);
  await q(`UPDATE sessions SET active = false, ended_at = now() WHERE id = $1`, [session.id]);
  const n = await registerChunks(session.id, stream.id, dir);
  await onSessionEnded(session.id); // "Save the full recording" → join the chunks into one MP4
  if (downloaded) await fs.rm(source, { force: true });
  if (stream.kind === 'file') await fs.rm(source, { force: true }).catch(() => {});
  log.info(`queued ${n} chunks for analysis (${stream.name})`);
  await job.updateProgress(100);
}
