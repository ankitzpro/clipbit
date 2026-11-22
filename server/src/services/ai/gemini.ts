/**
 * Google Gemini (multimodal) client over plain REST — no SDK needed.
 * Sends the low-res chunk proxy (video + audio) inline together with the transcript and audio peaks,
 * and asks for structured JSON moments.
 */
import fs from 'node:fs/promises';
import { config } from '../../config.js';
import { logger } from '../../lib/log.js';
import type { LearningProfile, Segment, Signals } from './types.js';
import { fmtTime } from './boundaries.js';

const log = logger('gemini');
const API = 'https://generativelanguage.googleapis.com/v1beta';
export const CATEGORIES = ['funny', 'action', 'unexpected', 'reaction', 'commentary', 'fail', 'win', 'close_call', 'other'] as const;

export const geminiEnabled = () => !!config.gemini.apiKey;

// Model selection: Settings override > model Google told us to switch to > GEMINI_MODEL env/default.
let settingsModel = '';
let autoModel = '';
export const setGeminiModelOverride = (m: string) => {
  settingsModel = (m || '').trim();
};
export const activeGeminiModel = () => settingsModel || autoModel || config.gemini.model;

// Last success / failure, so the dashboard can show why AI isn't working instead of failing silently.
export interface GeminiHealth { ok: boolean; at: string; model: string; error?: string }
let healthListener: ((h: GeminiHealth) => void) | null = null;
export const onGeminiHealth = (fn: (h: GeminiHealth) => void) => {
  healthListener = fn;
};
const report = (h: GeminiHealth) => {
  try {
    healthListener?.(h);
  } catch {
    /* ignore */
  }
};

export class GeminiQuotaError extends Error {}

async function generate(model: string, parts: any[], schema?: any, temperature = 0.4): Promise<any> {
  const hasMedia = parts.some((p) => p.inline_data);
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature,
      // ~4x fewer tokens per video frame — plenty for spotting gameplay moments, and kinder to the free quota
      ...(hasMedia ? { mediaResolution: 'MEDIA_RESOLUTION_LOW' } : {}),
      responseMimeType: 'application/json',
      ...(schema ? { responseSchema: schema } : {}),
    },
  };
  let lastErr: unknown;
  let switched = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${API}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': config.gemini.apiKey },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) {
      const text = (await res.text()).slice(0, 600);
      // retired model: Google's error names the replacement ("...use models/gemini-x-flash...") — switch automatically
      const suggested = text.match(/use (?:models\/)?(gemini-[\w.-]+)/i)?.[1];
      if (res.status === 404 && suggested && !switched && suggested !== model) {
        log.warn(`model ${model} is retired; switching to ${suggested}`);
        autoModel = suggested;
        if (model === settingsModel) settingsModel = '';
        model = suggested;
        switched = true;
        attempt--;
        continue;
      }
      const err = new Error(`Gemini ${res.status} (${model}): ${text}`);
      report({ ok: false, at: new Date().toISOString(), model, error: err.message.slice(0, 400) });
      throw err;
    }
    const json: any = await res.json();
    const text = (json.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || '').join('');
    if (!text) throw new Error(`Gemini returned no content (${json.candidates?.[0]?.finishReason || json.promptFeedback?.blockReason || 'unknown'})`);
    report({ ok: true, at: new Date().toISOString(), model });
    try {
      return JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]);
      throw new Error('Gemini returned invalid JSON');
    }
  }
  const msg = String((lastErr as Error)?.message || lastErr);
  report({ ok: false, at: new Date().toISOString(), model, error: msg.slice(0, 400) });
  if (/Gemini 429/.test(msg)) throw new GeminiQuotaError(msg);
  throw lastErr;
}

export const momentSchema = {
  type: 'OBJECT',
  properties: {
    mission: { type: 'STRING', description: 'name of the mission/activity happening in this segment' },
    moments: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          start_sec: { type: 'NUMBER', description: 'seconds from the start of THIS video where the clip should begin (include context)' },
          end_sec: { type: 'NUMBER', description: 'seconds from the start of THIS video where the clip should end' },
          peak_sec: { type: 'NUMBER', description: 'the exact second of the key moment / punchline' },
          title: { type: 'STRING', description: 'catchy YouTube Shorts title, max 70 chars, no hashtags' },
          description: { type: 'STRING', description: 'one or two sentences: what happens and why it is entertaining' },
          category: { type: 'STRING', enum: [...CATEGORIES] },
          evidence: {
            type: 'OBJECT',
            description: 'honest checklist, each 0-3, judged ONLY from what you can see/hear in this clip',
            properties: {
              event: { type: 'INTEGER', description: '0 nothing happens (driving, walking, menus) · 1 minor · 2 clear event · 3 big event (crash, kill, chase ends, epic fail/win)' },
              novelty: { type: 'INTEGER', description: '0 routine gameplay · 1 slightly unusual · 2 surprising · 3 wild / never seen' },
              payoff: { type: 'INTEGER', description: '0 no result shown · 1 partial · 2 result shown · 3 strong punchline/result inside the clip' },
              reaction: { type: 'INTEGER', description: '0 silent / calm · 1 mild comment · 2 clear reaction · 3 laughing, screaming, shocked' },
              standalone: { type: 'INTEGER', description: '2-SECOND TEST: would the first 2 seconds make a stranger with no context keep watching? 0 no / confusing · 3 instantly hooked and gets it' },
            },
            required: ['event', 'novelty', 'payoff', 'reaction', 'standalone'],
          },
          viral_score: { type: 'INTEGER', description: 'your overall 0-100 guess (used only for comparison)' },
          hashtags: { type: 'ARRAY', items: { type: 'STRING' } },
          keywords: { type: 'ARRAY', items: { type: 'STRING' }, description: '1-4 spoken words worth highlighting in captions' },
          transcript_excerpt: { type: 'STRING' },
        },
        required: ['start_sec', 'end_sec', 'peak_sec', 'title', 'description', 'category', 'evidence', 'hashtags'],
      },
    },
  },
  required: ['mission', 'moments'],
};

const STYLE_TEXT: Record<string, string> = {
  funny: 'funny moments, jokes, absurd glitches, comedic timing',
  action: 'action-packed gameplay: chases, shootouts, stunts, epic kills, wins',
  unexpected: 'unexpected or surprising events, plot twists, chaos',
  reactions: 'strong streamer reactions: screaming, laughing, shock, rage',
  commentary: 'interesting or witty conversation and commentary',
  viral_only: 'ONLY moments with very high viral potential; be strict',
};

export interface GeminiMomentRaw {
  start_sec: number; end_sec: number; peak_sec: number; title: string; description: string;
  category: string; viral_score?: number; hashtags: string[]; keywords?: string[]; transcript_excerpt?: string;
  evidence?: { event?: number; novelty?: number; payoff?: number; reaction?: number; standalone?: number };
}

export interface MomentArgs {
  proxyFile: string;
  chunkStart: number; // session time of t=0 in the proxy
  duration: number;
  transcript: Segment[];
  signals: Signals;
  context: string;
  styles: string[];
  maxMoments: number;
  clipMin: number;
  clipMax: number;
  learning?: LearningProfile;
  model?: string;
  previousMission?: string | null;
}

/** Prompt shared by every provider. `media` says whether the model gets the video or still frames. */
export function buildMomentPrompt(args: MomentArgs, media: { kind: 'video' } | { kind: 'frames'; times: number[] }) {
  const rel = (t: number) => Math.max(0, t - args.chunkStart);
  const transcriptLines = args.transcript
    .map((s) => `[${rel(s.start).toFixed(1)}-${rel(s.end).toFixed(1)}] ${s.text.trim()}`)
    .join('\n');
  const peaks = args.signals.peaks.map((p) => `${rel(p.t).toFixed(0)}s (${p.kind}, strength ${p.strength})`).join(', ');

  const L = args.learning;
  const learningText = L && (L.totalReviewed > 0 || L.ratedExamples?.length)
    ? [
        `The creator has reviewed ${L.totalReviewed} clips so far.`,
        Object.keys(L.categoryApproval).length
          ? 'Approval rate by category: ' + Object.entries(L.categoryApproval).map(([c, v]) => `${c} ${Math.round(v.rate * 100)}% (${v.approved}/${v.approved + v.rejected})`).join(', ') + '.'
          : '',
        L.approvedExamples.length ? 'Examples the creator APPROVED: ' + L.approvedExamples.slice(0, 6).map((t) => `"${t}"`).join('; ') + '.' : '',
        L.rejectedExamples.length ? 'Examples the creator REJECTED: ' + L.rejectedExamples.slice(0, 6).map((r) => `"${r.title}"${r.reason ? ` (reason: ${r.reason})` : ''}`).join('; ') + '.' : '',
        L.ratedExamples?.length ? 'The creator\'s own star ratings (1-5): ' + L.ratedExamples.map((r) => `"${r.title}" ${r.stars}★`).join('; ') + '.' : '',
        L.topPerformers.length ? 'Best performing published Shorts: ' + L.topPerformers.slice(0, 5).map((p) => `"${p.title}" ${p.views} views`).join('; ') + '.' : '',
        'Prefer moments similar to approved/top-performing ones and avoid ones like the rejected examples.',
      ].filter(Boolean).join('\n')
    : '';

  const mediaText = media.kind === 'video'
    ? 'Watch the video and listen to the audio.'
    : `You are given one image: a 3x2 grid of ${media.times.length} frames from this segment, read left to right then top to bottom, taken at these seconds: ${media.times.map((t) => t.toFixed(0)).join(', ')}. Use them together with the transcript and the audio spikes to understand what happens.`;

  return `You are an expert short-form video editor who finds viral YouTube Shorts in long live streams.
Content: ${args.context}. This is a ${Math.round(args.duration)}-second segment (starting at stream time ${fmtTime(args.chunkStart)}).

${mediaText} Find at most ${args.maxMoments} moments that would work as a standalone ${args.clipMin}-${args.clipMax} second vertical Short.
Look for: ${args.styles.map((s) => STYLE_TEXT[s] || s).join('; ')}. Also: epic kills/wins/losses, close calls, high-energy moments, memorable or unusual events.

Rules:
- All times are in seconds from the start of THIS segment (0 to ${Math.round(args.duration)}).
- start_sec: the shortest lead-in that still makes sense to a viewer with no context (usually 2-8s before the peak). The first 2 seconds must already be interesting (the 2-second test) — open on the action or the line, not on setup. end_sec should include the reaction/punchline and must not cut off a sentence.
- Each clip must be ${args.clipMin}-${args.clipMax}s long. A moment may run past the end of this segment (end_sec up to ${Math.round(args.duration) + 20}) if the action clearly continues.
- evidence: answer each checklist item 0-3 honestly from what you actually see and hear — the score is computed from it, so do not inflate. Most gameplay is 0-1; reserve 3 for things a stranger would replay. Do not return segments where nothing happens at all. Return an empty list if nothing is worth clipping.
- Titles must describe what actually happens (who/what/where), punchy, curiosity-driven, under 70 characters, may include one emoji, no hashtags, never a timestamp. Hashtags: 3-6, include the game.
- keywords: 1-4 exact words spoken in the clip that deserve highlighted captions.

Also return "mission": the name of the mission / activity happening in this segment — use the in-game mission title or objective text if visible, otherwise a short label for what the player is actually doing in THESE frames, written as "Free roam - <activity>" (max 6 words). Base it only on what you see; examples of the format (do not copy them): "Free roam - swimming underwater", "Free roam - street race", "Free roam - shootout at gas station".${args.previousMission ? ` The previous segment was "${args.previousMission}": reuse EXACTLY that name if it is still the same mission.` : ''}

Audio/visual spikes our signal analysis detected (relative seconds): ${peaks || 'none'}.
Transcript (relative seconds):
${transcriptLines || '(no speech detected)'}
${learningText ? '\nCreator preferences learned from feedback:\n' + learningText : ''}`;
}

export function parseMomentResult(res: any): { mission: string; moments: GeminiMomentRaw[] } {
  const moments: GeminiMomentRaw[] = Array.isArray(res?.moments) ? res.moments : [];
  return {
    mission: String(res?.mission || '').trim().slice(0, 80),
    moments: moments.filter((m) => Number.isFinite(m.start_sec) && Number.isFinite(m.end_sec) && m.end_sec > m.start_sec),
  };
}

export async function detectMomentsGemini(args: MomentArgs): Promise<{ mission: string; moments: GeminiMomentRaw[] }> {
  const video = await fs.readFile(args.proxyFile);
  if (video.length > 18 * 1024 * 1024) throw new Error('analysis proxy too large for inline request');
  const res = await generate(
    args.model || activeGeminiModel(),
    [{ inline_data: { mime_type: 'video/mp4', data: video.toString('base64') } }, { text: buildMomentPrompt(args, { kind: 'video' }) }],
    momentSchema,
  );
  return parseMomentResult(res);
}

/** Speech-to-text fallback when the local Whisper service isn't available. Word timings are approximated later. */
export async function transcribeGemini(wavFile: string, offset: number, model?: string): Promise<Segment[]> {
  const audio = await fs.readFile(wavFile);
  const res = await generate(
    model || activeGeminiModel(),
    [
      { inline_data: { mime_type: 'audio/wav', data: audio.toString('base64') } },
      { text: 'Transcribe all speech in this audio verbatim. Split into short phrases (max ~8 words) with accurate start/end times in seconds from the start of the audio. Return {"segments":[{"start":0.0,"end":1.2,"text":"..."}]}. Return an empty list if there is no speech.' },
    ],
    {
      type: 'OBJECT',
      properties: {
        segments: {
          type: 'ARRAY',
          items: { type: 'OBJECT', properties: { start: { type: 'NUMBER' }, end: { type: 'NUMBER' }, text: { type: 'STRING' } }, required: ['start', 'end', 'text'] },
        },
      },
      required: ['segments'],
    },
    0.1,
  );
  return (res?.segments || [])
    .filter((s: any) => s.text && s.end > s.start)
    .map((s: any) => ({ start: s.start + offset, end: s.end + offset, text: String(s.text).trim() }));
}

/** Rewrite title/description/hashtags for a clip (used by "Regenerate metadata"). */
export async function rewriteMetadata(
  args: { transcript: string; currentTitle: string; context: string; category?: string },
  gen: (parts: any[], schema: any, temperature: number) => Promise<any> = (parts, schema, t) => generate(activeGeminiModel(), parts, schema, t),
) {
  return gen(
    [{
      text: `Write fresh YouTube Shorts metadata for a ${args.context} clip (${args.category || 'highlight'}).
Current title: "${args.currentTitle}". Transcript: "${args.transcript.slice(0, 1500)}".
Return {"title": "...(max 70 chars, punchy, one emoji max, no hashtags)", "description": "...(1-2 sentences)", "hashtags": ["#..."]} with 3-6 hashtags.`,
    }],
    {
      type: 'OBJECT',
      properties: { title: { type: 'STRING' }, description: { type: 'STRING' }, hashtags: { type: 'ARRAY', items: { type: 'STRING' } } },
      required: ['title', 'description', 'hashtags'],
    },
    0.8,
  ) as Promise<{ title: string; description: string; hashtags: string[] }>;
}

/** Generic structured-JSON call (used by the AI edit planner). */
export const geminiGenerate = (parts: any[], schema?: any, temperature = 0.4, model?: string) =>
  generate(model || activeGeminiModel(), parts, schema, temperature);
