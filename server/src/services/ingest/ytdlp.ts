/**
 * yt-dlp wrapper. Used only for streams the user owns or has explicit permission to process
 * (the dashboard requires that confirmation for every stream). No DRM or access-control bypassing:
 * private, members-only, age-gated or DRM-protected content will simply fail and be reported.
 */
import { config } from '../../config.js';
import { run } from '../../lib/proc.js';

const extra = (process.env.YTDLP_EXTRA_ARGS || '').split(' ').filter(Boolean);
// YouTube needs a JS runtime + the EJS challenge solver to expose real video formats. Without them only
// storyboard images are returned and every format request fails with "Requested format is not available".
const baseArgs = ['--no-warnings', '--no-playlist', '--js-runtimes', 'node', '--remote-components', 'ejs:github', '--socket-timeout', '20', ...extra];

const FORMAT_HINT =
  'YouTube returned no downloadable formats. Usually yt-dlp is out of date or YouTube is challenging this server: ' +
  'rebuild to get the newest yt-dlp (docker compose build --no-cache app worker), or set YTDLP_EXTRA_ARGS in .env ' +
  '(e.g. --extractor-args youtube:player_client=default,web_safari). Members-only/private videos cannot be processed.';

function explain(stderr: string) {
  const err = stderr.split('\n').filter((l) => /ERROR/.test(l)).join(' ') || stderr.slice(-400);
  const msg = err.replace(/\s+/g, ' ').trim() || 'yt-dlp failed';
  return /Requested format is not available|No video formats found/i.test(msg) ? `${msg} — ${FORMAT_HINT}` : msg;
}

export interface StreamInfo {
  isLive: boolean;
  wasLive: boolean;
  title: string;
  channel: string;
  id: string;
  duration?: number;
  webpageUrl: string;
  upcoming: boolean;
}

/** For channel URLs, the /live suffix points at the current live broadcast (if any). */
export function liveUrlFor(url: string, kind: string) {
  if (kind !== 'channel') return url;
  const u = url.replace(/\/+$/, '').replace(/\/(featured|videos|streams|live)$/, '');
  return `${u}/live`;
}

export function classifyUrl(url: string): 'channel' | 'video' | 'invalid' {
  try {
    const u = new URL(url);
    if (!/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(u.hostname)) return 'invalid';
    if (u.hostname.endsWith('youtu.be') || u.pathname.startsWith('/watch') || u.pathname.startsWith('/live/') || u.pathname.startsWith('/shorts/')) return 'video';
    if (/^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/.test(u.pathname)) return 'channel';
    return 'invalid';
  } catch {
    return 'invalid';
  }
}

export async function getInfo(url: string): Promise<StreamInfo> {
  const res = await run(config.ytdlpBin, [...baseArgs, '-J', '--skip-download', '--ignore-no-formats-error', url], { allowFail: true, timeoutMs: 90_000 });
  if (res.code !== 0) {
    const err = explain(res.stderr);
    const notLive = /not currently live|will begin|is offline|no live|This live event will begin|Premieres in|does not have a live stream/i.test(err);
    if (notLive) return { isLive: false, wasLive: false, title: '', channel: '', id: '', webpageUrl: url, upcoming: /will begin|Premieres/i.test(err) };
    throw new Error(err);
  }
  const j = JSON.parse(res.stdout);
  return {
    isLive: j.is_live === true || j.live_status === 'is_live',
    wasLive: j.was_live === true || j.live_status === 'was_live' || j.live_status === 'post_live',
    upcoming: j.live_status === 'is_upcoming',
    title: j.title || '',
    channel: j.channel || j.uploader || '',
    id: j.id || '',
    duration: j.duration || undefined,
    webpageUrl: j.webpage_url || url,
  };
}

/**
 * Direct media URL(s) for a live broadcast, capped at 1080p. Prefers a single muxed HLS stream; falls back to
 * separate video + audio URLs. URLs expire after a few hours (the recorder reconnects with fresh ones).
 */
export async function getLiveMediaUrls(url: string): Promise<string[]> {
  const res = await run(
    config.ytdlpBin,
    [...baseArgs, '-g', '-f', 'b[height<=1080][protocol*=m3u8]/b[height<=1080]/bv*[height<=1080]+ba/b/bv*+ba', url],
    { timeoutMs: 90_000, allowFail: true },
  );
  if (res.code !== 0) throw new Error(explain(res.stderr));
  const urls = res.stdout.split('\n').map((s) => s.trim()).filter((s) => /^https?:/.test(s));
  if (!urls.length) throw new Error('yt-dlp returned no media URL');
  return urls.slice(0, 2);
}

/**
 * Download a finished video / past broadcast (≤1080p, merged to mp4).
 * Prefers H.264 + AAC: chunks are MPEG-TS stream copies, and TS can't carry AV1/VP9 (YouTube's usual "best" codecs) —
 * they end up as an unreadable data stream and every chunk fails analysis. segmentFile() also transcodes as a safety net.
 */
export const VOD_FORMAT = [
  'bv*[height<=1080][vcodec^=avc1]+ba[acodec^=mp4a]',
  'bv*[height<=1080][vcodec^=avc1]+ba',
  'b[height<=1080][vcodec^=avc1]',
  'bv*[height<=1080]+ba', 'b[height<=1080]', 'bv*+ba', 'b',
].join('/');

export async function downloadVod(url: string, outFileNoExt: string, onProgress?: (pct: number) => void) {
  await run(
    config.ytdlpBin,
    [...baseArgs, '-f', VOD_FORMAT, '--merge-output-format', 'mp4', '--newline', '-o', `${outFileNoExt}.%(ext)s`, url],
    {
      allowFail: true,
      onStdout: (s) => {
        const m = s.match(/\[download\]\s+([\d.]+)%/g);
        if (m && onProgress) onProgress(Number(m[m.length - 1].replace(/[^\d.]/g, '')));
      },
    },
  ).then((r) => {
    if (r.code !== 0) throw new Error(explain(r.stderr));
  });
  return `${outFileNoExt}.mp4`;
}

export async function ytdlpVersion(): Promise<string | null> {
  try {
    return (await run(config.ytdlpBin, ['--version'], { timeoutMs: 10_000 })).stdout.trim();
  } catch {
    return null;
  }
}
