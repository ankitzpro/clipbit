/**
 * Clip renderer: recorded chunks + time range -> polished 1080x1920 Short.
 * Steps: assemble range -> (dead-air cut) -> reframe -> animated captions -> loudness-normalised H.264/AAC.
 * Pure (no DB) so it can be tested and reused.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { ffmpeg, probe } from '../../lib/proc.js';
import type { Segment } from '../ai/types.js';
import { assembleRange, thumbnail, type ChunkRef } from './media.js';
import { applyCuts, detectSilences, isTrimmed, keepSegments, mapTime, mapTimeClamp, type KeepSegment } from './deadair.js';
import { planReframe, OUT_H, OUT_W, type FacecamRect, type ReframeMode } from './reframe.js';
import { audioBeats, pickBeats } from './punchin.js';
import { buildAss, type CaptionStyle, type HookBanner } from './captions.js';

export interface RenderOptions {
  reframeMode: ReframeMode;
  facecam?: FacecamRect | null;
  captions: { enabled: boolean } & CaptionStyle;
  deadAir: { enabled: boolean; minSilence: number; noiseDb: number };
  video: { crf: number; preset: string; fps: number; punchIn?: boolean };
  minDuration: number;
}

export interface RenderInput {
  chunks: ChunkRef[];
  start: number; // session time
  end: number;
  peak?: number;
  captions: Segment[]; // session time
  keywords: string[];
  hook?: HookBanner | null;
  sfx?: { t: number; file: string }[]; // t = session time
  sfxVolume?: number;
  /** branding bumpers (any size/aspect; normalised to 1080x1920 with a blurred fill) */
  intro?: string | null;
  outro?: string | null;
  workDir: string;
  options: RenderOptions;
  onProgress?: (pct: number) => void;
}

export interface RenderOutput {
  file: string;
  thumb: string;
  duration: number;
  keep: KeepSegment[];
}

export async function renderClip(inp: RenderInput): Promise<RenderOutput> {
  const { workDir, options: o } = inp;
  await fs.mkdir(workDir, { recursive: true });
  const report = (p: number) => inp.onProgress?.(Math.max(0, Math.min(100, Math.round(p))));

  // 1) assemble the source range
  const raw = path.join(workDir, 'source.mp4');
  await assembleRange(inp.chunks, inp.start, inp.end, raw);
  report(15);
  let src = raw;
  let info = await probe(src);

  // 2) dead air
  let keep: KeepSegment[] = [{ start: 0, end: info.duration }];
  let trimmed = false;
  if (o.deadAir.enabled && info.hasAudio) {
    const { silences } = await detectSilences(src, o.deadAir.noiseDb, o.deadAir.minSilence);
    keep = keepSegments(info.duration, silences, Math.max(o.minDuration, 5));
    if (isTrimmed(keep, info.duration)) {
      src = await applyCuts(raw, keep, path.join(workDir, 'trimmed.mp4'), info.hasAudio);
      info = await probe(src);
      trimmed = true;
    }
  }
  report(30);

  // 3) reframe plan (runs saliency analysis for smart mode)
  // punch-in beats (clip time): the moment's peak + audio leaps (services/video/punchin.ts, ported from openshorts)
  let beats: number[] = [];
  if (o.video.punchIn !== false && (o.reframeMode === 'smart' || o.reframeMode === 'center')) {
    const peakRel = inp.peak !== undefined ? (trimmed ? mapTimeClamp(inp.peak - inp.start, keep) : inp.peak - inp.start) : null;
    beats = pickBeats(peakRel, info.hasAudio ? await audioBeats(src) : [], info.duration);
  }
  const plan = await planReframe(src, info.width, info.height, o.reframeMode, workDir, o.facecam, beats, o.video.fps);
  report(40);

  // 4) captions + hook banner
  let graph = plan.graph;
  const relT = (t: number) => (trimmed ? mapTimeClamp(t - inp.start, keep) : t - inp.start);
  const shifted: Segment[] = !o.captions.enabled ? [] : inp.captions
    .map((s) => {
      const words = s.words?.filter((w) => !trimmed || mapTime((w.start + w.end) / 2 - inp.start, keep) !== null)
        .map((w) => ({ ...w, start: relT(w.start), end: relT(w.end) }));
      return { start: relT(s.start), end: relT(s.end), text: words?.length ? words.map((w) => w.word).join(' ') : s.text, words };
    })
    .filter((s) => s.end > 0 && s.start < info.duration && s.end - s.start > 0.05);
  const hook = inp.hook && inp.hook.text.trim() ? inp.hook : null;
  if (shifted.length || hook) {
    await fs.writeFile(path.join(workDir, 'captions.ass'), buildAss(shifted, o.captions, inp.keywords, info.duration, hook));
    graph += `;[vr]ass=captions.ass,fps=${o.video.fps}[vout]`;
  } else {
    graph += `;[vr]fps=${o.video.fps}[vout]`;
  }

  // audio: loudness-normalise, then lay sound effects on top
  const sfxInputs: string[] = [];
  if (info.hasAudio) {
    const cues = (inp.sfx || [])
      .map((c) => ({ file: c.file, at: relT(c.t) }))
      .filter((c) => c.at >= 0 && c.at < info.duration - 0.2);
    if (!cues.length) {
      graph += `;[0:a]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]`;
    } else {
      graph += `;[0:a]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,aformat=channel_layouts=stereo[amain]`;
      const vol = Math.max(0, Math.min(1.5, inp.sfxVolume ?? 0.55));
      const labels: string[] = [];
      cues.forEach((c, i) => {
        sfxInputs.push('-i', c.file);
        const ms = Math.round(c.at * 1000);
        graph += `;[${i + 1}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${vol.toFixed(2)},adelay=${ms}|${ms}[sfx${i}]`;
        labels.push(`[sfx${i}]`);
      });
      graph += `;[amain]${labels.join('')}amix=inputs=${cues.length + 1}:normalize=0:duration=first:dropout_transition=0,alimiter=limit=0.95[aout]`;
    }
  }

  // 5) intro / outro bumpers, concatenated in the same encode (no extra generation loss)
  const extraInputs: string[] = [];
  let nextInput = 1 + sfxInputs.length / 2;
  let vLabel = '[vout]';
  let aLabel: string | null = info.hasAudio ? '[aout]' : null;
  let introDur = 0;
  let total = info.duration;
  const bumpers = [inp.intro ? { kind: 'intro', file: inp.intro } : null, inp.outro ? { kind: 'outro', file: inp.outro } : null].filter(Boolean) as { kind: string; file: string }[];
  if (bumpers.length) {
    const silent = (dur: number, label: string) => {
      extraInputs.push('-f', 'lavfi', '-t', dur.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo');
      graph += `;[${nextInput++}:a]anull${label}`;
    };
    if (!aLabel) {
      silent(info.duration, '[aout]');
      aLabel = '[aout]';
    }
    const parts: Record<string, { v: string; a: string }> = {};
    for (const b of bumpers) {
      const bi = await probe(b.file);
      const idx = nextInput++;
      extraInputs.push('-i', b.file);
      graph +=
        `;[${idx}:v]split=2[${b.kind}bg][${b.kind}fg]` +
        `;[${b.kind}bg]scale=${OUT_W / 4}:${OUT_H / 4}:force_original_aspect_ratio=increase,crop=${OUT_W / 4}:${OUT_H / 4},boxblur=10:2,scale=${OUT_W}:${OUT_H}[${b.kind}bgb]` +
        `;[${b.kind}fg]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease[${b.kind}fgs]` +
        `;[${b.kind}bgb][${b.kind}fgs]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=${o.video.fps},format=yuv420p[${b.kind}v]`;
      if (bi.hasAudio) graph += `;[${idx}:a]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,aformat=channel_layouts=stereo[${b.kind}a]`;
      else silent(bi.duration, `[${b.kind}a]`);
      parts[b.kind] = { v: `[${b.kind}v]`, a: `[${b.kind}a]` };
      if (b.kind === 'intro') introDur = bi.duration;
      total += bi.duration;
    }
    graph += `;${vLabel}format=yuv420p,setsar=1[mainv];${aLabel}aformat=channel_layouts=stereo[maina]`;
    const seq = [parts.intro, { v: '[mainv]', a: '[maina]' }, parts.outro].filter(Boolean) as { v: string; a: string }[];
    graph += `;${seq.map((p) => p.v + p.a).join('')}concat=n=${seq.length}:v=1:a=1[vcat][acat]`;
    vLabel = '[vcat]';
    aLabel = '[acat]';
  }

  // 6) final encode (cwd = workDir so filter file references stay relative & escape-free)
  const out = path.join(workDir, 'short.mp4');
  await ffmpeg(
    [
      '-i', path.basename(src), ...sfxInputs, ...extraInputs, '-filter_complex', graph, '-map', vLabel, ...(aLabel ? ['-map', aLabel] : []),
      '-c:v', 'libx264', '-preset', o.video.preset, '-crf', String(o.video.crf), '-profile:v', 'high', '-pix_fmt', 'yuv420p',
      '-s', `${OUT_W}x${OUT_H}`, ...(aLabel ? ['-c:a', 'aac', '-b:a', '160k', '-ar', '48000'] : []),
      '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', path.basename(out),
    ],
    {
      cwd: workDir,
      onStdout: (s) => {
        const m = s.match(/out_time_(?:ms|us)=(\d+)/g);
        if (m) {
          const us = Number(m[m.length - 1].split('=')[1]);
          report(40 + (us / 1e6 / Math.max(1, total)) * 58);
        }
      },
    },
  );

  const peakRel = introDur + (inp.peak !== undefined ? mapTimeClamp(inp.peak - inp.start, keep) : info.duration / 2);
  const thumb = await thumbnail(out, Math.min(total - 0.1, Math.max(0, peakRel)), path.join(workDir, 'thumb.jpg'));
  const final = await probe(out);
  report(100);
  return { file: out, thumb, duration: final.duration, keep };
}

/** Quick low-res preview of the raw source around a clip (used by Clip Studio to pick new trim points). */
export async function renderSourcePreview(chunks: ChunkRef[], start: number, end: number, out: string) {
  await assembleRange(chunks, start, end, out, { scaleHeight: 360, crf: 30 });
  return out;
}

export { ffmpeg };

/**
 * Join already-rendered Shorts (identical codec settings) without re-encoding.
 * Used for mission Shorts and for the AI preview of multi-part clips.
 */
export async function concatShorts(files: string[], out: string) {
  const list = out + '.concat.txt';
  await fs.writeFile(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out]);
  await fs.rm(list, { force: true });
  return out;
}
