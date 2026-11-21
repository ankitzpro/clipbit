import fs from 'node:fs/promises';
import path from 'node:path';
import { ffmpeg, probe } from '../../lib/proc.js';
import { logger } from '../../lib/log.js';

const log = logger('segment');

export interface SegmentEntry { file: string; start: number; end: number; idx: number }

/** Parse ffmpeg's `-segment_list_type csv` output: "chunk_00000.ts,0.000000,60.033333" */
export async function readSegmentList(dir: string, listName = 'segments.csv'): Promise<SegmentEntry[]> {
  let text = '';
  try {
    text = await fs.readFile(path.join(dir, listName), 'utf8');
  } catch {
    return [];
  }
  const out: SegmentEntry[] = [];
  for (const line of text.split('\n')) {
    const [name, s, e] = line.trim().split(',');
    if (!name || s === undefined || e === undefined) continue;
    const idx = Number((name.match(/(\d+)\.\w+$/) || [])[1]);
    out.push({ file: path.join(dir, name), start: Number(s), end: Number(e), idx: Number.isFinite(idx) ? idx : out.length });
  }
  return out;
}

/** ffmpeg args (output side) that write fixed-length MPEG-TS chunks plus a CSV index. */
export const segmentOutputArgs = (dir: string, chunkSec: number, separateAudio = false, codecArgs: string[] = ['-c', 'copy']) => [
  '-map', '0:v:0?', '-map', separateAudio ? '1:a:0?' : '0:a:0?', ...codecArgs,
  '-f', 'segment', '-segment_time', String(chunkSec), '-segment_format', 'mpegts',
  '-segment_list', path.join(dir, 'segments.csv'), '-segment_list_type', 'csv', '-segment_list_flags', '+live',
  '-reset_timestamps', '0',
  path.join(dir, 'chunk_%05d.ts'),
];

// Codecs MPEG-TS can carry and the rest of the pipeline reads. Anything else (AV1, VP9, VP8, Vorbis…) would be
// stream-copied as an opaque data stream → chunks without video → every analysis fails ("does not contain any stream").
const TS_VIDEO = new Set(['h264', 'hevc', 'mpeg2video']);
const TS_AUDIO = new Set(['aac', 'mp3', 'mp2', 'ac3', 'eac3', 'opus']);

/** Per-stream codec args for segmenting `input`: copy what TS supports, re-encode the rest (H.264 / AAC). */
export async function tsCodecArgs(input: string, chunkSec: number): Promise<{ args: string[]; transcoded: string[] }> {
  const p = await probe(input);
  const transcoded: string[] = [];
  const v = !p.videoCodec || TS_VIDEO.has(p.videoCodec)
    ? ['-c:v', 'copy']
    : (transcoded.push(`video ${p.videoCodec}→h264`),
      ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
        // keyframe on every chunk boundary so each chunk starts cleanly
        '-force_key_frames', `expr:gte(t,n_forced*${chunkSec})`,
        // the forced keyframe can land a hair before the boundary (timebase rounding); let the segmenter accept it
        '-segment_time_delta', '0.05']);
  const a = !p.audioCodec || TS_AUDIO.has(p.audioCodec)
    ? ['-c:a', 'copy']
    : (transcoded.push(`audio ${p.audioCodec}→aac`), ['-c:a', 'aac', '-b:a', '192k']);
  return { args: [...v, ...a], transcoded };
}

/** Split an existing file (VOD download / user upload) into chunks. */
export async function segmentFile(input: string, dir: string, chunkSec: number) {
  await fs.mkdir(dir, { recursive: true });
  const { args, transcoded } = await tsCodecArgs(input, chunkSec);
  if (transcoded.length) log.info(`re-encoding for chunking (${transcoded.join(', ')}) — slower than a copy: ${path.basename(input)}`);
  await ffmpeg(['-i', input, ...segmentOutputArgs(dir, chunkSec, false, args)]);
  return readSegmentList(dir);
}
