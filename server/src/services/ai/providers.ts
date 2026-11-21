/**
 * AI provider routing. Two jobs, each with its own preferred provider and automatic fallback to the other:
 *  - detect: scan every analysed minute for moments (frequent → local Ollama by default, free)
 *  - edit:   hook / title / caption clean-up for clips you render (rare → Gemini by default, best quality)
 */
import { probe } from '../../lib/proc.js';
import { errMsg, logger } from '../../lib/log.js';
import type { AppSettings } from '../../settings-defaults.js';
import {
  buildMomentPrompt, detectMomentsGemini, geminiEnabled, geminiGenerate, GeminiQuotaError, momentSchema, parseMomentResult,
  type GeminiMomentRaw, type MomentArgs,
} from './gemini.js';
import { contactSheet, frameTimes, ollamaJson, ollamaStatus } from './ollama.js';
import fs from 'node:fs/promises';

const log = logger('ai');
export type Provider = 'gemini' | 'ollama';

async function available(p: Provider) {
  if (p === 'gemini') return geminiEnabled();
  return (await ollamaStatus()).ready;
}

function order(primary: Provider): Provider[] {
  return primary === 'ollama' ? ['ollama', 'gemini'] : ['gemini', 'ollama'];
}

export async function anyProviderAvailable() {
  return (await available('gemini')) || (await available('ollama'));
}

/** Run `fn` with each provider in preference order until one succeeds. */
async function withFallback<T>(primary: Provider, fn: (p: Provider) => Promise<T>): Promise<{ result: T; provider: Provider }> {
  const errors: { p: Provider; e: unknown }[] = [];
  for (const p of order(primary)) {
    if (!(await available(p))) continue;
    try {
      return { result: await fn(p), provider: p };
    } catch (e) {
      errors.push({ p, e });
      log.warn(`${p} failed: ${errMsg(e).slice(0, 200)}`);
    }
  }
  if (!errors.length) throw new Error('No AI provider available — set GEMINI_API_KEY or start Ollama with a vision model');
  // only quota problems left → caller can retry later
  if (errors.every((x) => x.e instanceof GeminiQuotaError)) throw errors[0].e;
  const nonQuota = errors.find((x) => !(x.e instanceof GeminiQuotaError));
  throw nonQuota ? nonQuota.e : errors[0].e;
}

export async function detectMoments(args: MomentArgs, settings: AppSettings): Promise<{ mission: string; moments: GeminiMomentRaw[]; provider: Provider }> {
  const { result, provider } = await withFallback(settings.aiProvider.detect, async (p) => {
    if (p === 'gemini') return detectMomentsGemini(args);
    const times = frameTimes(args.duration, args.signals.peaks.map((x) => x.t - args.chunkStart), 6);
    const sheets = await contactSheet(args.proxyFile, times);
    const res = await ollamaJson(buildMomentPrompt(args, { kind: 'frames', times }), sheets, momentSchema, 0.3);
    return parseMomentResult(res);
  });
  return { ...result, provider };
}

/** Structured JSON from text + (optional) video of the clip. Ollama gets still frames of the video. */
export async function generateJson(
  prompt: string,
  videoFile: string | null | undefined,
  schema: any,
  temperature: number,
  primary: Provider,
): Promise<{ result: any; provider: Provider }> {
  return withFallback(primary, async (p) => {
    if (p === 'gemini') {
      const video = videoFile ? await fs.readFile(videoFile).catch(() => null) : null;
      const parts = video && video.length < 18 * 1024 * 1024
        ? [{ inline_data: { mime_type: 'video/mp4', data: video.toString('base64') } }, { text: prompt }]
        : [{ text: prompt }];
      return geminiGenerate(parts, schema, temperature);
    }
    let frames: string[] = [];
    let note = '';
    if (videoFile) {
      const d = (await probe(videoFile).catch(() => null))?.duration || 0;
      if (d > 0) {
        // ~1 frame per 5 s so long clips (mission Shorts) don't hide whole events between frames:
        // 6 frames (1 grid) up to 30 s, 12 (2 grids) up to 60 s, max 18 (3 grids). Each grid costs ~1 image of tokens.
        const n = Math.min(18, Math.max(6, Math.ceil(d / 30) * 6));
        const times = frameTimes(d, [], n);
        frames = await contactSheet(videoFile, times);
        note = frames.length > 1
          ? `\n(Instead of the video you get ${frames.length} images, in time order. Each is a 3x2 grid of frames read left to right, top to bottom. Together they cover the whole clip at ${times.map((t) => t.toFixed(0) + 's').join(', ')}. Consider ALL images before deciding what happens.)`
          : `\n(Instead of the video you get one image: a 3x2 grid of frames read left to right, top to bottom, taken at ${times.map((t) => t.toFixed(0) + 's').join(', ')}.)`;
      }
    }
    return ollamaJson(prompt + note, frames, schema, temperature);
  });
}
