import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.js';
import { ffmpeg, run, runBuffer } from '../../lib/proc.js';

const range = (start?: number, dur?: number) => [
  ...(start !== undefined && start > 0 ? ['-ss', start.toFixed(3)] : []),
  ...(dur !== undefined ? ['-t', dur.toFixed(3)] : []),
];

/** 16 kHz mono WAV, the format Whisper wants. */
export async function extractAudioWav(input: string, out: string, start?: number, dur?: number) {
  await ffmpeg([...range(start, dur), '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out]);
  return out;
}

/**
 * Momentary loudness (LUFS, 400ms window) sampled per second.
 * Silence comes back as about -70. Returns [] if the input has no audio.
 */
export async function loudnessPerSecond(input: string, start?: number, dur?: number): Promise<number[]> {
  const { stderr } = await run(
    config.ffmpegBin,
    ['-hide_banner', '-nostdin', ...range(start, dur), '-i', input, '-vn', '-af', 'ebur128=framelog=info', '-f', 'null', '-'],
    { allowFail: true },
  );
  const perSec: number[] = [];
  const re = /t:\s*([\d.]+)\s+TARGET:[^M]*M:\s*(-?[\d.]+|-inf|nan)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr))) {
    const t = Math.floor(Number(m[1]));
    const v = Number(m[2]);
    const val = Number.isFinite(v) ? Math.max(v, -70) : -70;
    perSec[t] = perSec[t] === undefined ? val : Math.max(perSec[t], val);
  }
  for (let i = 0; i < perSec.length; i++) if (perSec[i] === undefined) perSec[i] = -70;
  return perSec;
}

export interface GrayFrames {
  fps: number;
  width: number;
  height: number;
  frames: Uint8Array[];
}

/** Decode low-res grayscale frames (for motion/saliency analysis). */
export async function readGrayFrames(input: string, fps: number, width: number, height: number, start?: number, dur?: number): Promise<GrayFrames> {
  const buf = await runBuffer(config.ffmpegBin, [
    '-hide_banner', '-nostdin', '-v', 'error', ...range(start, dur), '-i', input,
    '-vf', `fps=${fps},scale=${width}:${height}:flags=area,format=gray`, '-f', 'rawvideo', '-',
  ]);
  const size = width * height;
  const frames: Uint8Array[] = [];
  for (let off = 0; off + size <= buf.length; off += size) frames.push(new Uint8Array(buf.buffer, buf.byteOffset + off, size));
  return { fps, width, height, frames };
}

/** Mean absolute frame difference per second (0..1) — a cheap "visual action" signal. */
export function activityPerSecond(g: GrayFrames): number[] {
  const out: number[] = [];
  const counts: number[] = [];
  for (let i = 1; i < g.frames.length; i++) {
    const a = g.frames[i - 1];
    const b = g.frames[i];
    let sum = 0;
    for (let p = 0; p < a.length; p += 2) sum += Math.abs(a[p] - b[p]);
    const v = sum / (a.length / 2) / 255;
    const sec = Math.floor(i / g.fps);
    out[sec] = (out[sec] || 0) + v;
    counts[sec] = (counts[sec] || 0) + 1;
  }
  return out.map((v, i) => v / (counts[i] || 1));
}

/** Small, cheap proxy video for multimodal AI analysis (keeps requests well under 20 MB). */
export async function makeAnalysisProxy(input: string, out: string, start?: number, dur?: number) {
  await ffmpeg([
    ...range(start, dur), '-i', input,
    '-vf', 'fps=2,scale=-2:360', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32',
    '-c:a', 'aac', '-b:a', '48k', '-ac', '1', '-movflags', '+faststart', out,
  ]);
  return out;
}

export interface ChunkRef { file: string; start_sec: number; end_sec: number }

/**
 * Assemble [start, end] (session time) from recorded chunks into one high-quality intermediate file.
 * Re-encodes so the cut is frame accurate regardless of where keyframes fall.
 */
export async function assembleRange(chunks: ChunkRef[], start: number, end: number, out: string, opts: { scaleHeight?: number; crf?: number } = {}) {
  const used = chunks.filter((c) => c.end_sec > start && c.start_sec < end).sort((a, b) => a.start_sec - b.start_sec);
  if (!used.length) throw new Error('no recorded chunks cover the requested range');
  const listFile = out + '.concat.txt';
  await fs.writeFile(listFile, used.map((c) => `file '${c.file.replace(/'/g, "'\\''")}'`).join('\n'));
  const offset = Math.max(0, start - used[0].start_sec);
  const vf = opts.scaleHeight ? ['-vf', `scale=-2:${opts.scaleHeight}`] : [];
  await ffmpeg([
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-ss', offset.toFixed(3), '-t', (end - start).toFixed(3),
    ...vf,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(opts.crf ?? 17), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-avoid_negative_ts', 'make_zero', out,
  ]);
  await fs.rm(listFile, { force: true });
  return out;
}

export async function thumbnail(input: string, at: number, out: string) {
  await ffmpeg(['-ss', Math.max(0, at).toFixed(2), '-i', input, '-frames:v', '1', '-vf', 'scale=540:-2', '-q:v', '3', out]);
  return out;
}

export const tmpName = (dir: string, name: string) => path.join(dir, name);
