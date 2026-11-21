/**
 * Saved full-length recordings. Streams with options.saveFullRecording get each finished session's 2-minute
 * chunks joined into ONE MP4 (stream copy — no re-encode, so it is fast and lossless) in media storage under
 * recordings/<streamId>/<sessionId>.mp4. These files are never removed by the raw-chunk retention job; only the
 * owner deletes them (Live Monitor → Recordings, or by removing the stream).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { one, q } from '../db/pool.js';
import { errMsg, logger } from '../lib/log.js';
import { ffmpeg, probe } from '../lib/proc.js';
import { storage } from '../lib/storage.js';
import { queues } from '../queues.js';

const log = logger('recordings');

export const recordingKey = (streamId: string, sessionId: string) => `recordings/${streamId}/${sessionId}.mp4`;

/** Queue joining a finished session into one MP4 (no-op while it is already queued/saving or saved). */
export async function requestSaveRecording(sessionId: string): Promise<boolean> {
  const row = await one<{ id: string }>(
    `UPDATE sessions SET recording_status = 'queued', recording_error = NULL
      WHERE id = $1 AND active = false AND COALESCE(recording_status, '') NOT IN ('queued','saving','ready') RETURNING id`,
    [sessionId],
  );
  if (!row) return false;
  await queues.maintenance.add('save-recording', { sessionId }, { jobId: `save-recording-${sessionId}-${Date.now()}`, attempts: 2, backoff: { type: 'fixed', delay: 30000 } });
  return true;
}

/** Called whenever a recording session ends (live recorder exit, crash recovery, VOD/file ingest). */
export async function onSessionEnded(sessionId: string) {
  const s = await one<{ save: boolean }>(
    `SELECT COALESCE((st.options->>'saveFullRecording')::boolean, false) AS save
       FROM sessions se JOIN streams st ON st.id = se.stream_id WHERE se.id = $1`,
    [sessionId],
  );
  if (s?.save) await requestSaveRecording(sessionId).catch((e) => log.warn(`could not queue recording save: ${errMsg(e)}`));
}

/** Worker side: join all chunks of the session (stream copy) and store the MP4. */
export async function saveRecording(sessionId: string) {
  const se = await one<{ id: string; stream_id: string; active: boolean }>(`SELECT id, stream_id, active FROM sessions WHERE id = $1`, [sessionId]);
  if (!se) return;
  if (se.active) throw new Error('session is still recording');
  await q(`UPDATE sessions SET recording_status = 'saving', recording_error = NULL WHERE id = $1`, [sessionId]);
  const work = path.join(config.dirs.work, `recording-${sessionId}`);
  try {
    const chunks = await q<{ file: string; status: string }>(`SELECT file, status FROM chunks WHERE session_id = $1 ORDER BY idx`, [sessionId]);
    if (!chunks.length) throw new Error('this recording has no video pieces');
    const present: string[] = [];
    for (const c of chunks) if (c.status !== 'purged' && (await fs.stat(c.file).then((s) => s.size > 0).catch(() => false))) present.push(c.file);
    if (!present.length) throw new Error('the raw video pieces were already deleted (Settings → Keep raw recordings)');
    if (present.length < chunks.length) log.warn(`session ${sessionId}: ${chunks.length - present.length} of ${chunks.length} pieces missing — saving the rest`);

    await fs.mkdir(work, { recursive: true });
    const list = path.join(work, 'list.txt');
    await fs.writeFile(list, present.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
    const out = path.join(work, 'full.mp4');
    // -c copy: no quality loss, ~disk speed. ADTS AAC → MP4 needs aac_adtstoasc (ffmpeg inserts it automatically).
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart', out], { timeoutMs: 3 * 60 * 60 * 1000 });
    const info = await probe(out);
    if (!info.videoCodec) throw new Error('joined file has no video');
    const bytes = (await fs.stat(out)).size;
    const key = recordingKey(se.stream_id, sessionId);
    await storage.put(out, key, 'video/mp4');
    await q(
      `UPDATE sessions SET recording_status = 'ready', recording_key = $2, recording_bytes = $3, recording_duration = $4, recording_saved_at = now(),
              recording_error = $5 WHERE id = $1`,
      [sessionId, key, bytes, info.duration, present.length < chunks.length ? `${chunks.length - present.length} piece(s) were already deleted, the rest was saved` : null],
    );
    log.info(`saved full recording of session ${sessionId}: ${(bytes / 1048576).toFixed(0)} MB, ${Math.round(info.duration / 60)} min`);
  } catch (e) {
    await q(`UPDATE sessions SET recording_status = 'failed', recording_error = $2 WHERE id = $1`, [sessionId, errMsg(e).slice(0, 300)]);
    throw e;
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** Remove a saved recording file (the session, its moments and clips stay). */
export async function deleteSavedRecording(sessionId: string) {
  const se = await one<{ recording_key: string | null }>(`SELECT recording_key FROM sessions WHERE id = $1`, [sessionId]);
  if (se?.recording_key) await storage.remove(se.recording_key).catch(() => {});
  await q(
    `UPDATE sessions SET recording_status = NULL, recording_key = NULL, recording_bytes = NULL, recording_duration = NULL,
            recording_saved_at = NULL, recording_error = NULL WHERE id = $1`,
    [sessionId],
  );
}

/** Remove all saved recordings of a stream (when the stream itself is removed). */
export async function deleteStreamRecordings(streamId: string) {
  await storage.removePrefix(`recordings/${streamId}`).catch(() => 0);
}
