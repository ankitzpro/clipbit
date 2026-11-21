/**
 * Live stream supervisor.
 * Every few seconds: for each live/channel stream that isn't paused, check whether it's live (yt-dlp),
 * start an ffmpeg recorder that writes fixed-length chunks, and queue every finished chunk for analysis.
 * Reconnects automatically with backoff; a Redis lock makes sure only one worker replica records.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Redis } from 'ioredis';
import { config } from '../config.js';
import { one, q } from '../db/pool.js';
import { logger, errMsg } from '../lib/log.js';
import { randomToken } from '../lib/crypto.js';
import { queues } from '../queues.js';
import { getSettings } from '../settings.js';
import { getInfo, getLiveMediaUrls, liveUrlFor } from '../services/ingest/ytdlp.js';
import { readSegmentList, segmentOutputArgs } from '../services/ingest/segment.js';
import { onSessionEnded } from '../services/recordings.js';

const log = logger('recorder');
const LOCK_KEY = 'clipforge:recorder-lock';

interface Rec {
  streamId: string;
  sessionId: string;
  dir: string;
  proc: ChildProcess;
  startedAt: number;
  seen: Set<number>;
  stopping?: string;
  stderrTail: string;
}

const recorders = new Map<string, Rec>();
const checking = new Set<string>();

/** Register newly completed chunks of a session and queue them for analysis. */
export async function registerChunks(sessionId: string, streamId: string, dir: string, seen?: Set<number>) {
  const list = await readSegmentList(dir);
  let added = 0;
  for (const e of list) {
    if (seen?.has(e.idx)) continue;
    const row = await one<{ id: string }>(
      `INSERT INTO chunks (session_id, stream_id, idx, file, start_sec, end_sec) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (session_id, idx) DO NOTHING RETURNING id`,
      [sessionId, streamId, e.idx, e.file, e.start, e.end],
    );
    seen?.add(e.idx);
    if (row) {
      added++;
      await queues.analyze.add('analyze', { chunkId: row.id }, { jobId: `analyze-${row.id}` });
    }
  }
  return added;
}

async function setStream(id: string, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  await q(
    `UPDATE streams SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
    [id, ...keys.map((k) => fields[k])],
  );
}

const later = (sec: number) => new Date(Date.now() + sec * 1000);

async function startRecorder(stream: any) {
  const settings = await getSettings();
  const url = liveUrlFor(stream.url, stream.kind);
  const info = await getInfo(url);
  await q(`UPDATE streams SET last_checked_at = now() WHERE id = $1`, [stream.id]);
  if (!info.isLive) {
    // a single-video URL whose broadcast already ended: nothing more to record
    const ended = stream.kind === 'live' && info.wasLive;
    await setStream(stream.id, {
      status: 'offline',
      last_error: ended ? 'Broadcast has ended. Add it as a VOD to clip the replay.' : info.upcoming ? 'Scheduled — waiting for the stream to start' : null,
      next_check_at: later(ended ? 600 : 90),
      fail_count: 0,
    });
    return;
  }

  const mediaUrls = await getLiveMediaUrls(url);
  const session = await one<{ id: string }>(
    `INSERT INTO sessions (stream_id, dir, title) VALUES ($1, '', $2) RETURNING id`,
    [stream.id, info.title],
  );
  const dir = path.join(config.dirs.recordings, stream.id, session!.id);
  await fs.mkdir(dir, { recursive: true });
  await q(`UPDATE sessions SET dir = $2 WHERE id = $1`, [session!.id, dir]);

  const inputOpts = ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '20', '-rw_timeout', '30000000'];
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'warning',
    ...mediaUrls.flatMap((u) => [...inputOpts, '-i', u]),
    ...segmentOutputArgs(dir, settings.chunkSeconds, mediaUrls.length > 1),
  ];
  const proc = spawn(config.ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const rec: Rec = { streamId: stream.id, sessionId: session!.id, dir, proc, startedAt: Date.now(), seen: new Set(), stderrTail: '' };
  recorders.set(stream.id, rec);
  proc.stderr!.on('data', (d: Buffer) => (rec.stderrTail = (rec.stderrTail + d.toString()).slice(-2000)));
  proc.on('close', (code) => void onRecorderExit(rec, code));
  await setStream(stream.id, { status: 'live', source_title: info.title || stream.source_title, last_error: null, fail_count: 0 });
  log.info(`recording "${stream.name}" (${info.title}) -> session ${session!.id}`);
}

async function onRecorderExit(rec: Rec, code: number | null) {
  recorders.delete(rec.streamId);
  try {
    await registerChunks(rec.sessionId, rec.streamId, rec.dir, rec.seen);
    await q(`UPDATE sessions SET active = false, ended_at = now() WHERE id = $1`, [rec.sessionId]);
    await onSessionEnded(rec.sessionId);
    const stream = await one<any>(`SELECT * FROM streams WHERE id = $1`, [rec.streamId]);
    if (!stream) return;
    if (rec.stopping) {
      log.info(`recorder for ${stream.name} stopped (${rec.stopping})`);
      if (rec.stopping === 'paused') await setStream(rec.streamId, { status: 'paused' });
      return;
    }
    const short = Date.now() - rec.startedAt < 60_000;
    const fails = short ? stream.fail_count + 1 : 0;
    log.warn(`recorder for ${stream.name} exited (code ${code}); will re-check`, rec.stderrTail.split('\n').slice(-3).join(' | '));
    await setStream(rec.streamId, {
      status: fails >= 3 ? 'error' : 'offline',
      last_error: fails >= 3 ? `Recorder keeps failing: ${rec.stderrTail.split('\n').filter(Boolean).slice(-1)[0] || 'unknown error'}` : null,
      fail_count: fails,
      next_check_at: later(fails ? Math.min(1800, 30 * 2 ** fails) : 15),
    });
  } catch (e) {
    log.error('error handling recorder exit', e);
  }
}

function stopRecorder(rec: Rec, reason: string) {
  rec.stopping = reason;
  rec.proc.kill('SIGINT'); // lets ffmpeg finalise the current segment
  setTimeout(() => rec.proc.exitCode === null && rec.proc.kill('SIGKILL'), 10_000);
}

async function tick() {
  const streams = await q<any>(`SELECT * FROM streams WHERE kind IN ('live','channel')`);
  const ids = new Set(streams.map((s) => s.id));
  for (const [id, rec] of recorders) if (!ids.has(id)) stopRecorder(rec, 'removed');

  for (const s of streams) {
    const rec = recorders.get(s.id);
    if (s.paused) {
      if (rec) stopRecorder(rec, 'paused');
      else if (s.status !== 'paused') await setStream(s.id, { status: 'paused' });
      continue;
    }
    if (rec) {
      await registerChunks(rec.sessionId, rec.streamId, rec.dir, rec.seen).catch((e) => log.warn('chunk scan failed', e));
      continue;
    }
    if (!s.permission_confirmed) continue;
    if (s.next_check_at && new Date(s.next_check_at).getTime() > Date.now()) continue;
    if (checking.has(s.id)) continue;
    checking.add(s.id);
    startRecorder(s)
      .catch(async (e) => {
        const fails = (s.fail_count || 0) + 1;
        log.warn(`stream ${s.name}: ${errMsg(e)}`);
        await setStream(s.id, { status: 'error', last_error: errMsg(e).slice(0, 500), fail_count: fails, next_check_at: later(Math.min(1800, 60 * 2 ** Math.min(fails, 5))) });
      })
      .finally(() => checking.delete(s.id));
  }
}

/** Sessions left "active" by a crashed worker: register their remaining chunks and close them. */
async function recoverOrphans() {
  const rows = await q<any>(`SELECT * FROM sessions WHERE active = true`);
  for (const r of rows) {
    if (r.dir) await registerChunks(r.id, r.stream_id, r.dir).catch(() => {});
    await q(`UPDATE sessions SET active = false, ended_at = COALESCE(ended_at, now()) WHERE id = $1`, [r.id]);
    await onSessionEnded(r.id);
  }
  await q(`UPDATE streams SET status = 'offline', next_check_at = now() WHERE status = 'live'`);
}

export function startRecorderSupervisor() {
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  const me = randomToken(8);
  let leader = false;
  let stopped = false;

  const loop = async () => {
    if (stopped) return;
    try {
      const got = await redis.set(LOCK_KEY, me, 'PX', 30_000, 'NX');
      if (got) {
        if (!leader) {
          log.info('acquired recorder leadership');
          leader = true;
          await recoverOrphans();
        }
      } else if ((await redis.get(LOCK_KEY)) === me) {
        await redis.pexpire(LOCK_KEY, 30_000);
      } else {
        leader = false;
      }
      if (leader) await tick();
    } catch (e) {
      log.error('supervisor tick failed', e);
    }
    setTimeout(loop, 5000);
  };
  void loop();

  return async () => {
    stopped = true;
    for (const rec of recorders.values()) stopRecorder(rec, 'shutdown');
    await new Promise((r) => setTimeout(r, recorders.size ? 3000 : 0));
    if ((await redis.get(LOCK_KEY)) === me) await redis.del(LOCK_KEY);
    redis.disconnect();
  };
}
