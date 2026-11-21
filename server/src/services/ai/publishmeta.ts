/**
 * YouTube upload metadata for the Publish dialog (title / description / hashtags). Two ways, both free:
 *  1. enhancePublishMetadata: the app's own AI (Gemini free tier / local Ollama) watches a low-res copy of the final
 *     Short and rewrites the metadata, built around the owner's optional one-line direction.
 *  2. buildChatPrompt + chatFrameSheet: a ready-made prompt + frame-grid image the owner pastes into their own
 *     Claude / ChatGPT chat app (their subscription, no API); the answer is pasted back and parsed in the UI.
 * Owner rule: everything must describe what actually happens in the clip.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.js';
import { errMsg, logger } from '../../lib/log.js';
import { probe } from '../../lib/proc.js';
import { storage } from '../../lib/storage.js';
import { makeAnalysisProxy } from '../video/media.js';
import { getLearningProfile } from '../learning.js';
import { contactSheet, frameTimes } from './ollama.js';
import { generateJson, type Provider } from './providers.js';

const log = logger('publishmeta');

export interface PublishDraft { title: string; description: string; hashtags: string[] }
export interface EnhancedPublish extends PublishDraft { notes: string[]; provider: Provider; watched: boolean }

export interface PublishContext {
  clip: {
    id: string; version?: number; file_key?: string | null; title: string; category?: string | null; duration?: number | null;
    edit_plan?: { hook?: string } | null; captions?: { segments?: { text: string }[] } | null;
  };
  draft: PublishDraft;
  /** the owner's own short direction, e.g. "jet crashes into the cop chopper, make it funny" — highest-priority facts */
  userPrompt?: string;
  mission?: string | null;
  momentDescription?: string | null;
  transcript?: string | null;
  context: string;
}

const schema = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING', description: 'YouTube Shorts title, 40-70 characters' },
    description: { type: 'STRING', description: '2-3 short lines, no hashtags' },
    hashtags: { type: 'ARRAY', items: { type: 'STRING' } },
    notes: { type: 'ARRAY', items: { type: 'STRING' }, description: 'what you changed and why, max 4 short items' },
  },
  required: ['title', 'description', 'hashtags', 'notes'],
};

/** 2 fps / 360p copy of the final Short — small enough for Gemini inline video, fine for frame grids. Cached per version. */
async function previewOf(clip: PublishContext['clip']): Promise<string | null> {
  if (!clip.file_key) return null;
  try {
    const src = await storage.localPath(clip.file_key);
    const out = path.join(config.dirs.work, `publish-${clip.id}-v${clip.version ?? 0}.mp4`);
    const done = await fs.stat(out).then((s) => s.size > 0).catch(() => false);
    return done ? out : await makeAnalysisProxy(src, out);
  } catch (e) {
    log.warn(`no preview for clip ${clip.id}: ${errMsg(e)}`);
    return null;
  }
}

/** Same frame count rule as the Ollama path: 6 up to 30 s, 12 up to 60 s, max 18. */
const chatFrameTimes = (duration: number) => frameTimes(duration, [], Math.min(18, Math.max(6, Math.ceil(duration / 30) * 6)));

/** One JPEG grid (3 columns, read left→right, top→bottom) of the whole Short, to drag into a chat app. */
export async function chatFrameSheet(clip: PublishContext['clip']): Promise<{ jpeg: Buffer; times: number[] } | null> {
  const video = await previewOf(clip);
  if (!video) return null;
  const d = (await probe(video).catch(() => null))?.duration || clip.duration || 0;
  if (!(d > 0)) return null;
  const times = chatFrameTimes(d);
  const [sheet] = await contactSheet(video, times, 3, 384, Math.ceil(times.length / 3));
  return sheet ? { jpeg: Buffer.from(sheet, 'base64'), times } : null;
}

async function buildPrompt(p: PublishContext, media: 'video' | 'frames' | 'none', frameTimesSec: number[] = []): Promise<string> {
  const learning = await getLearningProfile().catch(() => undefined);
  const transcript = (p.transcript || (p.clip.captions?.segments || []).map((s) => s.text).join(' ')).trim().slice(0, 1500);
  const learned = learning && learning.totalReviewed > 0
    ? [
        learning.topPerformers.length ? `Best performing Shorts on this channel: ${learning.topPerformers.slice(0, 5).map((t) => `"${t.title}" (${t.views} views)`).join('; ')}.` : '',
        learning.approvedExamples.length ? `Titles the creator approved: ${learning.approvedExamples.slice(0, 5).map((t) => `"${t}"`).join('; ')}.` : '',
        learning.rejectedExamples.length ? `Avoid styles like these rejected ones: ${learning.rejectedExamples.slice(0, 4).map((r) => `"${r.title}"`).join('; ')}.` : '',
      ].filter(Boolean).join('\n')
    : '';
  const sees = media === 'video' ? 'see and hear' : media === 'frames' ? 'see in the frames' : 'can verify from these details';
  const intro = media === 'video'
    ? 'WATCH the attached Short (video and audio) and write'
    : media === 'frames'
      ? `Look at the attached image (a grid of ${frameTimesSec.length} frames from the Short, read left to right then top to bottom, taken at ${frameTimesSec.map((t) => t.toFixed(0) + 's').join(', ')}) and write`
      : 'From the details below, write';
  const direction = p.userPrompt?.trim()
    ? `\nTHE CREATOR'S DIRECTION (follow it; it is the most reliable description of what happens and the angle they want): "${p.userPrompt.trim().slice(0, 500)}"\n`
    : '';

  return `You are a YouTube Shorts growth editor. ${intro} upload metadata for this gaming Short so more people click and watch, WITHOUT misleading them.
Content: ${p.context}. Category: ${p.clip.category || 'highlight'}.${p.mission ? ` Mission/activity: "${p.mission}".` : ''}${p.clip.duration ? ` Length: ${Math.round(p.clip.duration)}s.` : ''}
${direction}${p.clip.edit_plan?.hook ? `On-screen hook banner: "${p.clip.edit_plan.hook}".\n` : ''}${p.momentDescription ? `Automatic detector's note (may be wrong): ${p.momentDescription}\n` : ''}Transcript: ${transcript ? `"${transcript}"` : '(no speech)'}

Current draft (keep specific facts, names or jokes from it that are true to the clip):
- title: "${p.draft.title}"
- description: "${p.draft.description}"
- hashtags: ${p.draft.hashtags.join(' ') || '(none)'}
${learned ? `\nChannel history:\n${learned}\n` : ''}
Rules:
- Everything must describe what ACTUALLY happens in this clip (what you ${sees}, plus the creator's direction). Never invent events, kills, crashes, glitches or reactions.
- title: 40-70 characters, front-load the most interesting thing, curiosity without spoiling the payoff, at most one emoji, no hashtags, no ALL CAPS sentence, no timestamps, no "Part 1" unless it is a multi-part mission Short.
- description: 2-3 short lines: line 1 says what happens with the main search words (game name, mission/activity); line 2 a short question that invites comments; optional line 3 a soft call to subscribe. No hashtags in the description, no links, no emoji spam.
- hashtags: 3-5, most specific first, always include the game (e.g. #GTA6), CamelCase, no spaces, do NOT include #Shorts (added automatically).
- notes: up to 4 very short items saying what you changed and why.`;
}

/** Prompt for the owner's own Claude / ChatGPT chat — asks for a JSON block the Publish dialog can parse back. */
export async function buildChatPrompt(p: PublishContext): Promise<{ text: string; frames: number }> {
  const sheet = await chatFrameSheet(p.clip).catch(() => null);
  const times = sheet?.times || [];
  const base = await buildPrompt(p, times.length ? 'frames' : 'none', times);
  const text = `${base}

Reply with ONLY this JSON in a code block, nothing before or after it:
\`\`\`json
{"title": "...", "description": "line 1\\nline 2", "hashtags": ["#GTA6", "..."], "notes": ["..."]}
\`\`\``;
  return { text, frames: times.length };
}

const cleanTag = (t: string) => {
  const s = String(t || '').trim().replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '');
  return s ? `#${s}` : '';
};

/** The app's own AI (Gemini free tier, Ollama locally) — no paid API. */
export async function enhancePublishMetadata(p: PublishContext & { primary: Provider }): Promise<EnhancedPublish> {
  const video = await previewOf(p.clip);
  const prompt = await buildPrompt(p, video ? 'video' : 'none');
  const { result, provider } = await generateJson(prompt, video, schema, 0.6, p.primary);
  let title = String(result?.title || '').replace(/#\S+/g, '').replace(/\s+/g, ' ').trim();
  if (title.length > 100) title = title.slice(0, 97).trimEnd() + '...';
  const description = String(result?.description || '').replace(/(^|\s)#\S+/g, '$1').replace(/[ \t]+\n/g, '\n').trim().slice(0, 1500);
  const hashtags = [...new Set((Array.isArray(result?.hashtags) ? result.hashtags : []).map(cleanTag).filter((t: string) => t && !/^#shorts$/i.test(t)))]
    .slice(0, 5) as string[];
  const notes = (Array.isArray(result?.notes) ? result.notes : []).map((n: any) => String(n).trim()).filter(Boolean).slice(0, 4);
  if (!title) throw new Error('AI returned an empty title — try again');
  return { title, description, hashtags: hashtags.length ? hashtags : p.draft.hashtags, notes, provider, watched: !!video };
}
