import type { Segment } from './types.js';

export interface BoundaryOpts {
  min: number;
  max: number;
  minStart?: number; // earliest available session time
  maxEnd?: number; // latest available session time (undefined for a live stream still recording)
}

/**
 * Turn a rough AI/heuristic window into a clean clip window:
 * - keep some lead-in before the key moment so viewers get context
 * - never start or end in the middle of a sentence when we can avoid it
 * - leave a short tail for the reaction
 * - clamp to [min, max] seconds, keeping the peak around 55-65% of the clip
 */
export function refineBoundaries(rawStart: number, rawEnd: number, peak: number, transcript: Segment[], o: BoundaryOpts) {
  let start = Math.min(rawStart, peak - 3);
  let end = Math.max(rawEnd, peak + 2);

  const segAt = (t: number) => transcript.find((s) => s.start - 0.05 <= t && t <= s.end + 0.05);

  // snap start to the beginning of the sentence it lands in (if that's not too far back)
  const s0 = segAt(start);
  if (s0 && start - s0.start <= 5) start = s0.start - 0.25;
  // snap end to the end of the sentence it lands in, plus a reaction tail
  const s1 = segAt(end);
  if (s1 && s1.end - end <= 6) end = s1.end;
  end += 0.8;

  // duration clamps
  let dur = end - start;
  if (dur < o.min) {
    const need = o.min - dur;
    start -= need * 0.6;
    end += need * 0.4;
  } else if (dur > o.max) {
    // keep the peak ~60% of the way through
    start = Math.max(start, peak - o.max * 0.6);
    end = start + o.max;
    const se = segAt(end);
    if (se && se.start > start + o.min && end - se.start < 4) end = se.start - 0.1; // cut before a sentence starts, not mid-way
  }

  // keep within the available footage
  if (o.minStart !== undefined && start < o.minStart) {
    end += o.minStart - start;
    start = o.minStart;
  }
  if (o.maxEnd !== undefined && end > o.maxEnd) {
    start -= end - o.maxEnd;
    end = o.maxEnd;
    if (o.minStart !== undefined) start = Math.max(start, o.minStart);
  }
  dur = end - start;
  if (dur > o.max) end = start + o.max;
  return { start: round(start), end: round(end) };
}

const round = (v: number) => Math.round(v * 100) / 100;

export function transcriptText(transcript: Segment[], start: number, end: number) {
  return transcript
    .filter((s) => s.end > start && s.start < end)
    .map((s) => s.text.trim())
    .join(' ')
    .trim();
}

export const fmtTime = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};
