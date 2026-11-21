/**
 * Dead-air removal: find long silences and cut out their middle, leaving a little padding so speech
 * never sounds clipped. Produces a time map so captions stay in sync after the cut.
 */
import { config } from '../../config.js';
import { ffmpeg, run } from '../../lib/proc.js';

export interface KeepSegment { start: number; end: number } // in input-file time

export async function detectSilences(input: string, noiseDb: number, minSilence: number) {
  const { stderr } = await run(
    config.ffmpegBin,
    ['-hide_banner', '-nostdin', '-i', input, '-vn', '-af', `silencedetect=noise=${noiseDb}dB:d=${minSilence}`, '-f', 'null', '-'],
    { allowFail: true },
  );
  const out: { start: number; end: number }[] = [];
  let cur: number | null = null;
  for (const line of stderr.split('\n')) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) cur = Math.max(0, Number(s[1]));
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if (e && cur !== null) {
      out.push({ start: cur, end: Number(e[1]) });
      cur = null;
    }
  }
  return { silences: out, openSilenceStart: cur };
}

export function keepSegments(duration: number, silences: { start: number; end: number }[], minKeepTotal: number, pad = 0.3, trimEdges = true): KeepSegment[] {
  const usable = trimEdges ? silences : silences.filter((s) => s.start > 0.05 && s.end < duration - 0.05);
  const cuts = usable
    .map((s) => ({
      // silence touching the clip edges: trim it fully (keeping only the padding next to the speech)
      start: s.start <= 0.05 ? 0 : s.start + pad,
      end: s.end >= duration - 0.05 ? duration : Math.min(duration, s.end) - pad,
    }))
    .filter((c) => c.end - c.start >= 0.5);
  const keep: KeepSegment[] = [];
  let t = 0;
  for (const c of cuts) {
    if (c.start > t) keep.push({ start: t, end: c.start });
    t = Math.max(t, c.end);
  }
  if (t < duration) keep.push({ start: t, end: duration });
  // drop slivers that would just look like glitches
  for (let i = keep.length - 1; i >= 0; i--) if (keep[i].end - keep[i].start < 0.4 && keep.length > 1) keep.splice(i, 1);
  if (!keep.length) return [{ start: 0, end: duration }];
  const total = keep.reduce((a, k) => a + (k.end - k.start), 0);
  if (total < minKeepTotal) return trimEdges ? keepSegments(duration, silences, minKeepTotal, pad, false) : [{ start: 0, end: duration }];
  return keep;
}

/** Map an input-file time to output time after cuts; returns null when it falls inside a removed part. */
export function mapTime(t: number, keep: KeepSegment[]): number | null {
  let acc = 0;
  for (const k of keep) {
    if (t < k.start) return null;
    if (t <= k.end) return acc + (t - k.start);
    acc += k.end - k.start;
  }
  return null;
}

/** Clamp-map: like mapTime but snaps times in removed parts to the next kept boundary. */
export function mapTimeClamp(t: number, keep: KeepSegment[]): number {
  let acc = 0;
  for (const k of keep) {
    if (t < k.start) return acc;
    if (t <= k.end) return acc + (t - k.start);
    acc += k.end - k.start;
  }
  return acc;
}

export async function applyCuts(input: string, keep: KeepSegment[], out: string, hasAudio: boolean) {
  const parts: string[] = [];
  const labels: string[] = [];
  keep.forEach((k, i) => {
    parts.push(`[0:v]trim=start=${k.start.toFixed(3)}:end=${k.end.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
    if (hasAudio) parts.push(`[0:a]atrim=start=${k.start.toFixed(3)}:end=${k.end.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=0.04,afade=t=out:st=${Math.max(0, k.end - k.start - 0.04).toFixed(3)}:d=0.04[a${i}]`);
    labels.push(hasAudio ? `[v${i}][a${i}]` : `[v${i}]`);
  });
  if (keep.length === 1) {
    const k = keep[0];
    await ffmpeg([
      '-ss', k.start.toFixed(3), '-i', input, '-t', (k.end - k.start).toFixed(3),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', ...(hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : []), out,
    ]);
    return out;
  }
  const graph = `${parts.join(';')};${labels.join('')}concat=n=${keep.length}:v=1:a=${hasAudio ? 1 : 0}[v]${hasAudio ? '[a]' : ''}`;
  await ffmpeg([
    '-i', input, '-filter_complex', graph, '-map', '[v]', ...(hasAudio ? ['-map', '[a]'] : []),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', ...(hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : []), out,
  ]);
  return out;
}

export const isTrimmed = (keep: KeepSegment[], duration: number) =>
  keep.length > 1 || (keep.length === 1 && (keep[0].start > 0.01 || keep[0].end < duration - 0.01));
