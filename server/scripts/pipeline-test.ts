/**
 * Offline pipeline test (no DB/Redis/API keys needed):
 *   npx tsx scripts/pipeline-test.ts <input.mp4> [outDir]
 * Splits the file into chunks, runs signal analysis + heuristic moment detection,
 * then renders the top moment in every reframe mode with captions.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { segmentFile } from '../src/services/ingest/segment.js';
import { loudnessPerSecond, readGrayFrames, activityPerSecond } from '../src/services/video/media.js';
import { computeSignals } from '../src/services/ai/signals.js';
import { heuristicMoments } from '../src/services/ai/heuristic.js';
import { renderClip } from '../src/services/video/render.js';
import { defaultSettings } from '../src/settings-defaults.js';
import type { Segment } from '../src/services/ai/types.js';

const input = process.argv[2];
const outDir = path.resolve(process.argv[3] || './pipeline-out');
const modes = (process.env.MODES || 'smart,blur,center').split(',');
if (!input) throw new Error('usage: pipeline-test <input> [outDir]');

const t0 = Date.now();
const chunksDir = path.join(outDir, 'chunks');
await fs.rm(outDir, { recursive: true, force: true });
const segs = await segmentFile(path.resolve(input), chunksDir, 60);
console.log(`chunks: ${segs.length}`, segs.map((s) => `${s.idx}:${s.start.toFixed(1)}-${s.end.toFixed(1)}`).join(' '));

// fake transcript for caption testing (real runs use Whisper)
const transcript: Segment[] = process.env.FAKE_TRANSCRIPT === '0' ? [] : [
  { start: 66.2, end: 68.9, text: 'wait wait is that a cop behind us' },
  { start: 69.4, end: 72.8, text: 'oh my god no way he just flew off the bridge!' },
  { start: 73.0, end: 75.6, text: "let's go bro that was insane" },
  { start: 77.0, end: 79.0, text: 'did you see that' },
];

const history: number[] = [];
const all = [];
for (const c of segs) {
  const loud = await loudnessPerSecond(c.file);
  const g = await readGrayFrames(c.file, 2, 64, 36);
  const act = activityPerSecond(g);
  const tr = transcript.filter((s) => s.end > c.start && s.start < c.end);
  const sig = computeSignals(c.start, loud, act, tr, history);
  history.push(...loud);
  const ms = heuristicMoments(sig, transcript, { min: 10, max: 60, minStart: 0, maxEnd: segs.at(-1)!.end, maxMoments: 2, defaultHashtags: ['#GTA6', '#Shorts'] });
  console.log(`chunk ${c.idx}: peaks=${sig.peaks.slice(0, 3).map((p) => `${p.t}s/${p.kind}/${p.strength}`).join(', ')} moments=${ms.length}`);
  all.push(...ms);
}
all.sort((a, b) => b.score - a.score);
console.log('top moments:', all.slice(0, 4).map((m) => ({ s: m.start, e: m.end, peak: m.peak, score: m.score, cat: m.category, title: m.title })));
if (!all.length) throw new Error('no moments detected');

const m = all[0];
const s = defaultSettings;
for (const mode of modes) {
  const t1 = Date.now();
  const res = await renderClip({
    chunks: segs.map((c) => ({ file: c.file, start_sec: c.start, end_sec: c.end })),
    start: m.start, end: m.end, peak: m.peak, captions: transcript, keywords: ['insane', 'bridge'],
    workDir: path.join(outDir, `render-${mode}`),
    options: { reframeMode: mode as any, captions: s.captions, deadAir: s.deadAir, video: s.video, minDuration: 10, facecam: { x: 0.72, y: 0.05, w: 0.25, h: 0.3 } },
    onProgress: () => {},
  });
  console.log(`rendered ${mode}: ${res.file} ${res.duration.toFixed(2)}s keep=${JSON.stringify(res.keep.map((k) => [+k.start.toFixed(2), +k.end.toFixed(2)]))} in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
}
console.log(`total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
