/**
 * AI edit plan for a clip: hook banner text, cleaned-up captions, highlight words and sound-effect cues.
 * Gemini (text only, cheap) when configured; a simple heuristic otherwise.
 */
import fs from 'node:fs/promises';
import { logger, errMsg } from '../../lib/log.js';
import { anyProviderAvailable, generateJson, type Provider } from './providers.js';
import { distributeWords } from './transcribe.js';
import type { Segment, Word } from './types.js';

const log = logger('editplan');

export interface SfxCue { t: number; type: string } // t = session time
export interface EditPlan {
  hook: string;
  title?: string; // AI-suggested title after watching the clip
  keywords: string[];
  captions?: Segment[]; // corrected captions (session time); absent = use transcript as-is
  sfx: SfxCue[];
  source: 'gemini' | 'ollama' | 'heuristic' | 'user';
  createdAt: string;
  forStart?: number; // clip range the plan was made for
  forEnd?: number;
  userEdited?: boolean; // hook/sfx changed by the user in Clip Studio: never overwrite automatically
}

export interface PlanInput {
  start: number;
  end: number;
  peak?: number | null;
  title: string;
  description?: string | null;
  category?: string | null;
  keywords?: string[];
  segments: Segment[];
  context: string;
  sfxTypes: string[];
  maxSfx: number;
  smartCaptions: boolean;
  /** low-res proxy of exactly this clip range (video + audio) so the AI can watch it */
  videoFile?: string | null;
  provider?: Provider;
}

const ACTION = new Set(['action', 'close_call', 'win', 'fail', 'unexpected']);

export function cleanHook(s: string) {
  return s
    .replace(/[\p{Extended_Pictographic}‍️#"“”]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 7)
    .join(' ')
    .replace(/[.,!?…:;]+$/, '')
    .toUpperCase();
}

const STOP = new Set(['THE', 'A', 'AN', 'OF', 'OFF', 'TO', 'AND', 'IN', 'ON', 'AT', 'FOR', 'WITH', 'IS', 'WAS', 'BUT', 'OR', 'MY', 'HIS', 'HER']);
const GENERIC_HOOKS: Record<string, string> = {
  funny: 'I CANNOT STOP LAUGHING',
  action: 'WAIT FOR IT…',
  close_call: 'THAT WAS WAY TOO CLOSE',
  win: 'NO WAY THIS WORKED',
  fail: 'THIS WENT WRONG FAST',
  unexpected: 'NOBODY SAW THIS COMING',
  reaction: 'MY REACTION SAYS IT ALL',
  commentary: 'HE ACTUALLY SAID THIS',
};
/** Heuristic hook: first ≤6 words of the title, never ending on a dangling stop-word. */
function hookFromTitle(title: string, category?: string | null) {
  if (/wild moment at|moment at \d/i.test(title) || /^[\d:\s]+$/.test(title)) return GENERIC_HOOKS[category || ''] || 'WAIT FOR IT…';
  const words = cleanHook(title).split(' ').filter(Boolean).slice(0, 6);
  while (words.length > 2 && STOP.has(words[words.length - 1])) words.pop();
  return words.join(' ') + (words.length < cleanHook(title).split(' ').length ? '…' : '');
}

export function heuristicPlan(p: PlanInput): EditPlan {
  const peak = p.peak ?? (p.start + p.end) / 2;
  const sfx: SfxCue[] = [];
  if (p.sfxTypes.includes('whoosh')) sfx.push({ t: p.start + 0.05, type: 'whoosh' });
  const peakType = ACTION.has(p.category || '') ? 'boom' : p.category === 'funny' && p.sfxTypes.includes('laugh') ? 'laugh' : 'ding';
  if (p.sfxTypes.includes(peakType) && peak - p.start > 2) sfx.push({ t: peak, type: peakType });
  return {
    hook: hookFromTitle(p.title, p.category),
    keywords: p.keywords || [],
    sfx: sfx.slice(0, p.maxSfx),
    source: 'heuristic',
    createdAt: new Date().toISOString(),
  };
}

export async function planEdit(p: PlanInput): Promise<EditPlan> {
  if (!(await anyProviderAvailable())) return heuristicPlan(p);
  const rel = (t: number) => Math.max(0, t - p.start);
  const segs = p.segments.filter((s) => s.end > p.start && s.start < p.end);
  const lines = segs.map((s, i) => `${i}. [${rel(s.start).toFixed(1)}-${rel(s.end).toFixed(1)}] ${s.text}`).join('\n');
  const duration = p.end - p.start;
  const video = p.videoFile ? await fs.readFile(p.videoFile).catch(() => null) : null;
  const useVideo = !!video;
  const prompt = `You are a professional YouTube Shorts editor. ${useVideo ? 'WATCH the attached clip (video and audio) and plan' : 'Plan'} the edit for a ${duration.toFixed(1)}s vertical clip.
Content: ${p.context}. Moment: "${p.title}" (${p.category || 'highlight'}). ${p.description || ''}
Key moment at ${p.peak != null ? rel(p.peak).toFixed(1) + 's' : 'unknown'}.

Auto-transcribed captions (index. [start-end seconds] text):
${lines || '(no speech)'}

Return JSON with:
- "hook": a 3-6 word scroll-stopping hook shown as a banner in the first 3 seconds. Base it on what ACTUALLY happens in the clip${useVideo ? ' (what you see and hear)' : ''}, be specific to this moment, curiosity-driven, do NOT spoil the payoff, no emoji, no hashtags, never mention timestamps. e.g. "HE DID NOT SEE THIS COMING", "THE COPS HAD NO CHANCE".
- "title": a better YouTube Shorts title for this clip (max 70 chars, specific, may include one emoji, no hashtags).
- "captions": ${p.smartCaptions ? `an array with EXACTLY ${segs.length} strings, one per caption line above, same order. Fix speech-recognition mistakes (game names, places, slang: GTA, Vice City, Lucia, Jason…), remove filler words (um, uh), keep the speaker's words and tone otherwise. Use "" to drop a line that is pure noise.` : 'an empty array.'}
- "highlight": 2-6 exact words from the captions that deserve emphasis (punchlines, exclamations, names).
- "sfx": at most ${p.maxSfx} sound-effect cues [{"time": seconds from clip start, "type": one of ${JSON.stringify(p.sfxTypes)}}]. Use them sparingly to punch up the edit: e.g. whoosh at 0 for the hook, boom on a crash/explosion/kill, ding on a realisation, riser before a payoff, laugh only if genuinely funny. Keep cues at least 2s apart and avoid covering important speech. Return [] if effects would hurt the clip.`;

  try {
    const { result: res, provider }: { result: any; provider: Provider } = await generateJson(
      prompt,
      p.videoFile || null,
      {
        type: 'OBJECT',
        properties: {
          hook: { type: 'STRING' },
          title: { type: 'STRING' },
          captions: { type: 'ARRAY', items: { type: 'STRING' } },
          highlight: { type: 'ARRAY', items: { type: 'STRING' } },
          sfx: {
            type: 'ARRAY',
            items: { type: 'OBJECT', properties: { time: { type: 'NUMBER' }, type: { type: 'STRING' } }, required: ['time', 'type'] },
          },
        },
        required: ['hook', 'title', 'captions', 'highlight', 'sfx'],
      },
      0.6,
      p.provider || 'gemini',
    );
    const plan: EditPlan = {
      hook: cleanHook(String(res.hook || p.title)),
      title: res.title ? String(res.title).slice(0, 95) : undefined,
      keywords: (res.highlight || []).map(String).slice(0, 6),
      sfx: (res.sfx || [])
        .filter((c: any) => Number.isFinite(c.time) && c.time >= 0 && c.time < duration && p.sfxTypes.includes(String(c.type).toLowerCase()))
        .map((c: any) => ({ t: p.start + c.time, type: String(c.type).toLowerCase() }))
        .sort((a: SfxCue, b: SfxCue) => a.t - b.t)
        .filter((c: SfxCue, i: number, arr: SfxCue[]) => i === 0 || c.t - arr[i - 1].t >= 1.5)
        .slice(0, p.maxSfx),
      source: provider,
      createdAt: new Date().toISOString(),
    };
    if (p.smartCaptions && Array.isArray(res.captions) && res.captions.length === segs.length) {
      plan.captions = applyCaptionFixes(segs, res.captions.map(String));
    }
    return plan;
  } catch (e) {
    log.warn(`AI edit plan failed, using heuristic: ${errMsg(e)}`);
    return heuristicPlan(p);
  }
}

/** Replace caption text while keeping word timings where possible. */
export function applyCaptionFixes(segs: Segment[], corrected: string[]): Segment[] {
  const out: Segment[] = [];
  segs.forEach((s, i) => {
    const text = (corrected[i] ?? s.text).trim();
    if (!text) return;
    if (text === s.text.trim()) return void out.push(s);
    const newWords = text.split(/\s+/).filter(Boolean);
    let words: Word[];
    if (s.words && s.words.length === newWords.length) words = s.words.map((w, j) => ({ ...w, word: newWords[j] }));
    else if (s.words && s.words.length) words = distributeWords(text, s.words[0].start, s.words[s.words.length - 1].end);
    else words = distributeWords(text, s.start, s.end);
    out.push({ start: s.start, end: s.end, text, words });
  });
  return out;
}
