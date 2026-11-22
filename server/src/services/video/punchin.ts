/**
 * Punch-in: a short, small push toward the subject on the beats that carry the clip.
 * Ported from openshorts' punch_in.py (MIT) incl. its tuned constants: a static crop for 45 s is the most "unedited"
 * thing a vertical clip can do; a ~12 % push, fast in / hold / slow out, reads as an operator's intent.
 * Rides the smart-crop sendcmd path (reframe.ts) by widening the per-frame crop command from x to w/h/x/y.
 */
import { runBuffer } from '../../lib/proc.js';
import { config } from '../../config.js';

export const MAX_ZOOM = 1.12;          // crops ~11 % off each side: visible as intent, not as a blow-up
const RISE = 0.25, HOLD = 1.3, FALL = 0.55; // seconds: snap in, sit, drift out
const MIN_GAP = 18;                    // never punch twice within this (openshorts: 18 s ⇒ ~3 punches/min max)
const PROMINENCE = 0.6;                // beat must clear median + 60 % of the gap to the loudest point
const WINDOW = 0.2;                    // audio envelope resolution (s)

/** Smoothstep — linear ramps look mechanical at this duration. */
const ease = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/** Zoom factor (1 = untouched) for each output frame. Overlapping pushes take the strongest, never compound. */
export function zoomCurve(nFrames: number, fps: number, beats: number[], maxZoom = MAX_ZOOM): number[] {
  const z = new Array<number>(Math.max(0, nFrames)).fill(1);
  if (!z.length || maxZoom <= 1) return z;
  const span = RISE + HOLD + FALL;
  for (const t of beats) {
    for (let f = Math.max(0, Math.floor(t * fps)); f < Math.min(nFrames, Math.ceil((t + span) * fps) + 1); f++) {
      const dt = f / fps - t;
      if (dt < 0 || dt >= span) continue;
      const amount = dt < RISE ? ease(dt / RISE) : dt < RISE + HOLD ? 1 : 1 - ease((dt - RISE - HOLD) / FALL);
      z[f] = Math.max(z[f], 1 + (maxZoom - 1) * amount);
    }
  }
  return z;
}

/**
 * The same curve as zoomCurve(), as an ffmpeg expression over `it` (frame time, s) for zoompan's z=.
 * Overlapping beats take the max. Commas are fine: the whole expression is quoted inside the filtergraph.
 */
export function zoomExpr(beats: number[], maxZoom = MAX_ZOOM): string {
  const E = (u: string) => `(clip(${u},0,1)*clip(${u},0,1)*(3-2*clip(${u},0,1)))`; // smoothstep
  const amount = (t0: number) => {
    const d = `(it-${t0.toFixed(3)})`;
    return `if(lt(${d},0),0,if(lt(${d},${RISE}),${E(`${d}/${RISE}`)},if(lt(${d},${RISE + HOLD}),1,`
      + `if(lt(${d},${RISE + HOLD + FALL}),1-${E(`(${d}-${RISE + HOLD})/${FALL}`)},0))))`;
  };
  const terms = beats.map(amount);
  const strongest = terms.reduce((acc, t) => (acc ? `max(${acc},${t})` : t), '');
  return strongest ? `1+${(maxZoom - 1).toFixed(3)}*${strongest}` : '1';
}

/** Seconds where the audio leaps above its own baseline (RMS envelope). [] for silent/unreadable audio. */
export async function audioBeats(file: string): Promise<number[]> {
  let pcm: Buffer;
  try {
    pcm = await runBuffer(config.ffmpegBin, ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-']);
  } catch {
    return [];
  }
  const per = Math.round(8000 * WINDOW);
  const env: number[] = [];
  for (let i = 0; i + per * 2 <= pcm.length; i += per * 2) {
    let sum = 0;
    for (let j = 0; j < per; j++) {
      const v = pcm.readInt16LE(i + j * 2) / 32768;
      sum += v * v;
    }
    env.push(Math.sqrt(sum / per));
  }
  if (!env.length) return [];
  const sorted = [...env].sort((a, b) => a - b);
  const base = sorted[Math.floor(sorted.length / 2)];
  const peak = sorted[sorted.length - 1];
  if (peak - base <= 1e-4) return [];
  const thr = base + (peak - base) * PROMINENCE;
  const out: number[] = [];
  let last = -1e9;
  env.forEach((v, i) => {
    const t = i * WINDOW;
    if (v >= thr && t - last >= MIN_GAP) {
      out.push(Math.round(t * 1000) / 1000);
      last = t;
    }
  });
  return out;
}

/** The moment's peak always gets a push; audio beats fill in, keeping MIN_GAP between pushes. */
export function pickBeats(peak: number | null | undefined, audio: number[], duration: number): number[] {
  const beats: number[] = [];
  // land the push slightly before the peak so it is fully in when the moment hits
  if (peak != null && peak > 0.5 && peak < duration - 0.5) beats.push(Math.max(0, peak - RISE));
  for (const t of audio) if (t < duration - 0.5 && beats.every((b) => Math.abs(b - t) >= MIN_GAP)) beats.push(t);
  return beats.sort((a, b) => a - b);
}
