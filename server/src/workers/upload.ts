/** YouTube upload worker. Only runs for publications created from an explicitly approved clip. */
import fs from 'node:fs';
import type { Job } from 'bullmq';
import { google } from 'googleapis';
import { one, q } from '../db/pool.js';
import { logger, errMsg } from '../lib/log.js';
import { storage } from '../lib/storage.js';
import type { UploadJob } from '../queues.js';
import { getSettings } from '../settings.js';
import { authedClient } from '../services/youtube/client.js';

const log = logger('upload');

export async function processUpload(job: Job<UploadJob>) {
  const pub = await one<any>(
    `SELECT p.*, c.status AS clip_status, c.file_key, c.approved_at FROM publications p JOIN clips c ON c.id = p.clip_id WHERE p.id = $1`,
    [job.data.publicationId],
  );
  if (!pub || pub.status === 'published' || pub.status === 'scheduled') return;
  // Hard safety gate: never upload anything the user hasn't approved.
  if (!pub.approved_at || !['approved', 'published'].includes(pub.clip_status) || !pub.approved_by_user_at) {
    await q(`UPDATE publications SET status = 'failed', error = 'Clip is not approved', updated_at = now() WHERE id = $1`, [pub.id]);
    return;
  }
  if (!pub.file_key) throw new Error('clip file missing');

  const settings = await getSettings();
  await q(`UPDATE publications SET status = 'uploading', progress = 0, attempts = attempts + 1, error = NULL, updated_at = now() WHERE id = $1`, [pub.id]);

  try {
    const { client, account } = await authedClient(pub.account_id || undefined);
    const yt = google.youtube({ version: 'v3', auth: client });
    const file = await storage.localPath(pub.file_key);
    const size = fs.statSync(file).size;

    let title: string = pub.title.trim();
    let description: string = pub.description || '';
    const tags: string[] = pub.tags || [];
    const hashtagLine = tags.map((t) => (t.startsWith('#') ? t : `#${t}`)).join(' ');
    if (settings.publish.appendShortsTag && !/#shorts/i.test(title + ' ' + description + ' ' + hashtagLine)) description += (description ? '\n\n' : '') + '#Shorts';
    if (hashtagLine) description += (description ? '\n\n' : '') + hashtagLine;
    if (title.length > 100) title = title.slice(0, 97) + '...';
    title = title.replace(/[<>]/g, '');

    const scheduled = pub.publish_at && new Date(pub.publish_at).getTime() > Date.now() + 60_000;
    let lastPct = -1;
    const res = await yt.videos.insert(
      {
        part: ['snippet', 'status'],
        notifySubscribers: true,
        requestBody: {
          snippet: {
            title,
            description: description.slice(0, 4900),
            tags: tags.map((t) => t.replace(/^#/, '')).slice(0, 15),
            categoryId: settings.publish.categoryId || '20',
          },
          status: {
            // YouTube scheduling requires privacyStatus=private + publishAt
            privacyStatus: scheduled ? 'private' : pub.privacy,
            publishAt: scheduled ? new Date(pub.publish_at).toISOString() : undefined,
            selfDeclaredMadeForKids: false,
          },
        },
        media: { mimeType: 'video/mp4', body: fs.createReadStream(file) },
      },
      {
        onUploadProgress: (evt: any) => {
          const pct = Math.round((evt.bytesRead / size) * 100);
          if (pct !== lastPct && pct % 5 === 0) {
            lastPct = pct;
            void q(`UPDATE publications SET progress = $2 WHERE id = $1`, [pub.id, Math.min(99, pct)]);
            void job.updateProgress(pct);
          }
        },
      },
    );
    const videoId = res.data.id;
    if (!videoId) throw new Error('YouTube did not return a video id');
    await q(
      `UPDATE publications SET status = $2, youtube_video_id = $3, progress = 100, account_id = $4, updated_at = now() WHERE id = $1`,
      [pub.id, scheduled ? 'scheduled' : 'published', videoId, account.id],
    );
    await q(`UPDATE clips SET status = 'published', updated_at = now() WHERE id = $1`, [pub.clip_id]);
    log.info(`uploaded clip ${pub.clip_id} -> https://youtube.com/shorts/${videoId}${scheduled ? ' (scheduled)' : ''}`);
  } catch (e: any) {
    const apiMsg = e?.response?.data?.error?.message || e?.errors?.[0]?.message;
    const msg = apiMsg || errMsg(e);
    const quota = /quota/i.test(msg);
    const final = quota || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    await q(`UPDATE publications SET status = $2, error = $3, updated_at = now() WHERE id = $1`, [
      pub.id, final ? 'failed' : 'queued', (quota ? 'YouTube API quota exceeded — retry tomorrow. ' : '') + msg.slice(0, 500),
    ]);
    if (quota) return; // don't burn retries on quota errors
    throw e;
  }
}
