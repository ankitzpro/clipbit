import type { Segment, Signals } from './types.js';

const HYPE = [
  'no way', 'oh my god', 'omg', "let's go", 'lets go', 'what the', 'wtf', 'bro', 'yo', 'holy', 'insane', 'crazy',
  'clutch', 'run', 'help', 'oh no', 'wait', 'what', 'haha', 'hahaha', 'lol', 'lmao', 'dude', 'are you serious',
  'did you see', 'look at', 'watch this', 'boom', 'gg', 'nooo', 'yes', 'yesss', 'damn', 'shit', 'fuck',
];

function mean(a: number[]) {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}
function std(a: number[], m = mean(a)) {
  return a.length ? Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length) : 0;
}

/** Robust z-score of every value vs. the whole window (median/MAD so one spike doesn't hide others). */
function robustZ(a: number[]) {
  if (!a.length) return [];
  const sorted = [...a].sort((x, y) => x - y);
  const med = sorted[Math.floor(sorted.length / 2)];
  const mad = [...a.map((v) => Math.abs(v - med))].sort((x, y) => x - y)[Math.floor(a.length / 2)] || 0;
  const scale = mad * 1.4826 || std(a) || 1;
  return a.map((v) => (v - med) / scale);
}

export function hypeHits(text: string): number {
  const t = ' ' + text.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ') + ' ';
  let n = 0;
  for (const h of HYPE) if (t.includes(' ' + h + ' ')) n++;
  n += (text.match(/!/g) || []).length * 0.5;
  return n;
}

/**
 * Combine audio loudness, visual activity and transcript energy into ranked peaks.
 * `history` is the previous few minutes of loudness for this stream so the baseline adapts per streamer.
 */
export function computeSignals(offset: number, loudness: number[], activity: number[], transcript: Segment[], history: number[] = []): Signals {
  const n = Math.max(loudness.length, activity.length);
  const base = [...history.slice(-240), ...loudness].filter((v) => v > -69);
  const lm = mean(base);
  const ls = std(base, lm) || 3;
  const aZ = robustZ(activity);

  // speech energy per second: hype words + speech density
  const speech = new Array(n).fill(0);
  for (const s of transcript) {
    const a = Math.max(0, Math.floor(s.start - offset));
    const b = Math.min(n - 1, Math.floor(s.end - offset));
    const h = hypeHits(s.text);
    const wordsPerSec = s.text.split(/\s+/).length / Math.max(0.5, s.end - s.start);
    for (let i = a; i <= b; i++) speech[i] += h * 0.8 + Math.max(0, wordsPerSec - 2.5) * 0.4;
  }

  const combined: { t: number; strength: number; kind: 'audio' | 'visual' | 'speech' }[] = [];
  for (let i = 0; i < n; i++) {
    const lz = loudness[i] !== undefined && loudness[i] > -69 ? (loudness[i] - lm) / ls : -2;
    const vz = aZ[i] ?? 0;
    const sz = speech[i];
    const strength = Math.max(0, lz) * 1.0 + Math.max(0, vz) * 0.45 + sz * 0.6;
    const kind = sz > Math.max(lz, vz * 0.45) ? 'speech' : lz >= vz * 0.45 ? 'audio' : 'visual';
    combined.push({ t: offset + i, strength, kind });
  }

  // non-maximum suppression over 8s windows
  const sorted = [...combined].sort((a, b) => b.strength - a.strength);
  const peaks: Signals['peaks'] = [];
  for (const p of sorted) {
    if (p.strength < 1.6) break;
    if (peaks.some((q) => Math.abs(q.t - p.t) < 8)) continue;
    peaks.push({ ...p, strength: Math.round(p.strength * 100) / 100 });
    if (peaks.length >= 8) break;
  }
  return { loudness, activity, offset, peaks };
}
