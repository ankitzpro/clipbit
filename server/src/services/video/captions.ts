/**
 * Animated, word-highlighted captions rendered as an ASS subtitle file and burned in with libass.
 */
import type { Segment, Word } from '../ai/types.js';
import { distributeWords } from '../ai/transcribe.js';
import { OUT_H, OUT_W } from './reframe.js';

export interface CaptionStyle {
  fontName: string;
  fontSize: number;
  color: string;
  highlightColor: string;
  keywordColor: string;
  position: number;
  uppercase: boolean;
  animated: boolean;
  maxWordsPerLine: number;
}

/** #RRGGBB -> ASS &H00BBGGRR */
export function assColor(hex: string) {
  const h = hex.replace('#', '').padEnd(6, '0');
  return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

const assTime = (t: number) => {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};

const esc = (s: string) => s.replace(/\\/g, '').replace(/[{}]/g, '').replace(/\n/g, ' ');
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '');

/** Group words into short punchy lines (break on pauses, punctuation and max words). */
export function groupWords(words: Word[], maxWords: number): Word[][] {
  const groups: Word[][] = [];
  let cur: Word[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = cur[cur.length - 1];
    const gap = prev ? w.start - prev.end : 0;
    const chars = cur.reduce((a, x) => a + x.word.length + 1, 0);
    if (cur.length && (cur.length >= maxWords || gap > 0.6 || chars + w.word.length > 22 || /[.!?]$/.test(prev!.word))) {
      groups.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/**
 * Build the ASS document.
 * @param segments caption segments in source-clip time (already shifted so clip start = 0 and dead-air remapped)
 */
export interface HookBanner { text: string; seconds: number }

/** Split a hook into at most 3 balanced lines (~16 chars each). */
export function wrapHook(text: string, maxChars = 16): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > maxChars) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

export function buildAss(segments: Segment[], style: CaptionStyle, keywords: string[] = [], clipDuration = Infinity, hook?: HookBanner | null): string {
  const words: Word[] = [];
  for (const s of segments) {
    const ws = s.words && s.words.length ? s.words : distributeWords(s.text, s.start, s.end);
    for (const w of ws) if (w.end > 0 && w.start < clipDuration && w.word.trim()) words.push({ ...w, start: Math.max(0, w.start), end: Math.min(clipDuration, w.end) });
  }
  words.sort((a, b) => a.start - b.start);
  const kw = new Set(keywords.map(norm).filter(Boolean));
  const marginV = Math.round((1 - style.position) * OUT_H);
  const outline = Math.max(3, Math.round(style.fontSize / 13));

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${OUT_W}
PlayResY: ${OUT_H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,${style.fontName},${style.fontSize},${assColor(style.color)},${assColor(style.highlightColor)},&H00000000,&H96000000,-1,0,0,0,100,100,1,0,1,${outline},3,2,70,70,${marginV},1
Style: Hook,${style.fontName},88,&H00101010,&H00101010,&H00FFFFFF,&H64000000,-1,0,0,0,100,100,0,0,3,20,0,8,90,90,250,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines: string[] = [];
  if (hook && hook.text.trim()) {
    const end = Math.min(clipDuration, hook.seconds);
    const text = wrapHook(esc(hook.text.trim().toUpperCase())).join('\\N');
    const anim = '{\\fad(60,260)\\fscx55\\fscy55\\t(0,150,\\fscx106\\fscy106)\\t(150,240,\\fscx100\\fscy100)}';
    lines.push(`Dialogue: 1,${assTime(0)},${assTime(end)},Hook,,0,0,0,,${anim}${text}`);
  }
  const groups = groupWords(words, Math.max(1, style.maxWordsPerLine));
  groups.forEach((g, gi) => {
    const gStart = g[0].start;
    const next = groups[gi + 1];
    const gEnd = Math.min(next ? next[0].start : g[g.length - 1].end + 0.35, g[g.length - 1].end + 0.6);
    const label = (w: Word) => esc(style.uppercase ? w.word.toUpperCase() : w.word);
    const base = assColor(style.color);
    const render = (activeIdx: number, scaleActive: boolean) =>
      g
        .map((w, i) => {
          const isKw = kw.has(norm(w.word));
          if (i === activeIdx)
            return scaleActive
              ? `{\\c${assColor(style.highlightColor)}\\fscx112\\fscy112}${label(w)}{\\c${base}\\fscx100\\fscy100}`
              : `{\\c${assColor(style.highlightColor)}}${label(w)}{\\c${base}}`;
          if (isKw) return `{\\c${assColor(style.keywordColor)}}${label(w)}{\\c${base}}`;
          return label(w);
        })
        .join(' ');
    if (!style.animated) {
      lines.push(`Dialogue: 0,${assTime(gStart)},${assTime(gEnd)},Cap,,0,0,0,,${render(-1, false)}`);
      return;
    }
    g.forEach((w, i) => {
      const s = i === 0 ? gStart : w.start;
      const e = i === g.length - 1 ? gEnd : g[i + 1].start;
      if (e - s < 0.02) return;
      const pop = i === 0 ? '{\\fscx70\\fscy70\\t(0,110,\\fscx100\\fscy100)}' : '';
      lines.push(`Dialogue: 0,${assTime(s)},${assTime(e)},Cap,,0,0,0,,${pop}${render(i, i !== 0)}`);
    });
  });
  return header + lines.join('\n') + '\n';
}
