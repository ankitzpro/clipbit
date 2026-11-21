/** Offline test of a 3-part mission Short: npx tsx scripts/mission-test.ts <input.mp4> <outDir> */
import path from 'node:path';
import fs from 'node:fs/promises';
import { segmentFile } from '../src/services/ingest/segment.js';
import { renderClip, concatShorts } from '../src/services/video/render.js';
import { listSfx, pickSfx } from '../src/services/video/sfx.js';
import { probe } from '../src/lib/proc.js';
import { defaultSettings as s } from '../src/settings-defaults.js';

const [input, outArg] = process.argv.slice(2);
const out = path.resolve(outArg || './mission-out');
await fs.rm(out, { recursive: true, force: true });
const segs = await segmentFile(path.resolve(input), path.join(out, 'chunks'), 60);
const chunks = segs.map((c) => ({ file: c.file, start_sec: c.start, end_sec: c.end }));
const lib = await listSfx();
const parts = [{ start: 10, end: 22 }, { start: 66, end: 80 }, { start: 125, end: 137 }];
const files: string[] = [];
for (const [i, p] of parts.entries()) {
  const r = await renderClip({
    chunks, start: p.start, end: p.end, captions: [], keywords: [],
    hook: i === 0 ? { text: 'THE HEIST WENT SIDEWAYS', seconds: 2.8 } : null,
    sfx: i > 0 ? [{ t: p.start + 0.01, file: pickSfx(lib, 'whoosh', 'x')! }] : [],
    intro: i === 0 ? process.env.INTRO || null : null, outro: i === parts.length - 1 ? process.env.OUTRO || null : null,
    workDir: path.join(out, `part${i}`),
    options: { reframeMode: 'smart', captions: s.captions, deadAir: { ...s.deadAir, enabled: false }, video: s.video, minDuration: 3 },
  });
  console.log(`part ${i}: ${r.duration.toFixed(2)}s`);
  files.push(r.file);
}
const final = await concatShorts(files, path.join(out, 'mission.mp4'));
const info = await probe(final);
console.log('mission short', final, info.duration.toFixed(2), `${info.width}x${info.height}`, 'audio', info.hasAudio);
