/** Offline test of hook banner + caption fixes + SFX mixing: npx tsx scripts/aiedit-test.ts <input.mp4> <outDir> */
import path from 'node:path';
import fs from 'node:fs/promises';
import { segmentFile } from '../src/services/ingest/segment.js';
import { renderClip } from '../src/services/video/render.js';
import { listSfx, pickSfx } from '../src/services/video/sfx.js';
import { heuristicPlan, applyCaptionFixes } from '../src/services/ai/editplan.js';
import { withWords } from '../src/services/ai/transcribe.js';
import { defaultSettings as s } from '../src/settings-defaults.js';

const [input, outArg] = process.argv.slice(2);
const out = path.resolve(outArg || './aiedit-out');
await fs.rm(out, { recursive: true, force: true });
const segs = await segmentFile(path.resolve(input), path.join(out, 'chunks'), 60);
const transcript = withWords([
  { start: 66.2, end: 68.9, text: 'wait wait is that a cop behind us' },
  { start: 69.4, end: 72.8, text: 'oh my god no way he just flew off the bridge' },
  { start: 73.0, end: 75.6, text: "um let's go bro that was insane" },
]);
const lib = await listSfx();
console.log('sfx types:', Object.keys(lib));
const plan = heuristicPlan({ start: 64, end: 80, peak: 72.7, title: '"No way he just flew off the bridge!" 😳', category: 'action', segments: transcript, context: 'GTA 6', sfxTypes: Object.keys(lib), maxSfx: 4, smartCaptions: true, keywords: ['bridge'] });
const fixed = applyCaptionFixes(transcript, ['wait wait is that a cop behind us', 'oh my god no way he just flew off the bridge!', "let's go bro that was insane"]);
console.log('plan:', JSON.stringify(plan), '\nfixed[2]:', JSON.stringify(fixed[2]));
const res = await renderClip({
  chunks: segs.map((c) => ({ file: c.file, start_sec: c.start, end_sec: c.end })),
  start: 64, end: 80, peak: 72.7, captions: fixed, keywords: plan.keywords,
  hook: { text: plan.hook, seconds: s.aiEdit.hookSeconds },
  sfx: plan.sfx.map((c) => ({ t: c.t, file: pickSfx(lib, c.type, 'clip' + c.t)! })), sfxVolume: s.aiEdit.sfxVolume,
  intro: process.env.INTRO || null, outro: process.env.OUTRO || null,
  workDir: path.join(out, 'render'),
  options: { reframeMode: 'smart', captions: s.captions, deadAir: { ...s.deadAir, enabled: false }, video: s.video, minDuration: 10 },
});
console.log('rendered', res.file, res.duration);
