/** Periodic jobs: YouTube stats refresh (feeds the learning loop) and disk retention for raw recordings. */
import fs from 'node:fs/promises';
import type { Job } from 'bullmq';
import { google } from 'googleapis';
import { q } from '../db/pool.js';
import { logger, errMsg } from '../lib/log.js';
import { getSettings } from '../settings.js';
import { authedClient, getAccount } from '../services/youtube/client.js';
import { getLearningProfile } from '../services/learning.js';
import { saveRecording } from '../services/recordings.js';
import { rankSession } from '../services/ai/ranking.js';

const log = logger('maintenance');

export async function processMaintenance(job: Job) {
  if (job.name === 'stats') return refreshStats();
  if (job.name === 'cleanup') return cleanup();
  if (job.name === 'save-recording') return saveRecording(job.data.sessionId);
  if (job.name === 'rank-session') return rankSession(job.data.sessionId);
}

export async function refreshStats() {
  const acct = await getAccount();
  if (!acct) return;
  const pubs = await q<any>(
    `SELECT id, youtube_video_id, created_at FROM publications
      WHERE status IN ('published','scheduled') AND youtube_video_id IS NOT NULL ORDER BY created_at DESC LIMIT 200`,
  );
  if (!pubs.length) return;
  const { client } = await authedClient(acct.id);
  const yt = google.youtube({ version: 'v3', auth: client });
  const analytics = google.youtubeAnalytics({ version: 'v2', auth: client });

  for (let i = 0; i < pubs.length; i += 50) {
    const batch = pubs.slice(i, i + 50);
    const res = await yt.videos.list({ part: ['statistics', 'status'], id: batch.map((p) => p.youtube_video_id) });
    for (const v of res.data.items || []) {
      const p = batch.find((b) => b.youtube_video_id === v.id)!;
      const stats: Record<string, unknown> = {
        views: Number(v.statistics?.viewCount || 0),
        likes: Number(v.statistics?.likeCount || 0),
        comments: Number(v.statistics?.commentCount || 0),
        privacy: v.status?.privacyStatus,
      };
      // Retention via YouTube Analytics API (may be unavailable for new/low-traffic videos)
      try {
        const r = await analytics.reports.query({
          ids: 'channel==MINE',
          startDate: new Date(p.created_at).toISOString().slice(0, 10),
          endDate: new Date().toISOString().slice(0, 10),
          metrics: 'averageViewDuration,averageViewPercentage,shares,subscribersGained',
          filters: `video==${v.id}`,
        });
        const row = r.data.rows?.[0];
        if (row) Object.assign(stats, { avgViewDuration: Number(row[0]), avgViewPercentage: Number(row[1]), shares: Number(row[2]), subscribersGained: Number(row[3]) });
      } catch (e) {
        log.debug(`analytics unavailable for ${v.id}: ${errMsg(e)}`);
      }
      const views = Number(stats.views) || 0;
      stats.engagementRate = views ? Math.round(((Number(stats.likes) + Number(stats.comments)) / views) * 10000) / 100 : 0;
      const becamePublic = v.status?.privacyStatus === 'public';
      await q(
        `UPDATE publications SET stats = $2, stats_updated_at = now(), status = CASE WHEN status = 'scheduled' AND $3 THEN 'published' ELSE status END WHERE id = $1`,
        [p.id, JSON.stringify(stats), becamePublic],
      );
    }
  }
  await getLearningProfile(true);
  log.info(`refreshed stats for ${pubs.length} videos`);
}

/** Delete raw recording chunks older than the retention window (finished clips are kept). */
export async function cleanup() {
  const s = await getSettings();
  const rows = await q<{ id: string; file: string }>(
    `SELECT c.id, c.file FROM chunks c JOIN sessions se ON se.id = c.session_id
      WHERE c.status IN ('analyzed','failed') AND se.active = false AND c.created_at < now() - make_interval(hours => $1::int)
        AND COALESCE(se.recording_status, '') NOT IN ('queued','saving') -- full recording still being joined from these chunks
      LIMIT 2000`,
    [Math.round(s.retention.keepRecordingsHours)],
  );
  for (const r of rows) {
    await fs.rm(r.file, { force: true }).catch(() => {});
    await q(`UPDATE chunks SET status = 'purged' WHERE id = $1`, [r.id]);
  }
  if (rows.length) log.info(`purged ${rows.length} old recording chunks`);
}
