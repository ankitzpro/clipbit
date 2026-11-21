import fs from 'node:fs/promises';
import { config } from '../../config.js';
import { logger, errMsg } from '../../lib/log.js';
import { transcribeGemini, geminiEnabled } from './gemini.js';
import type { Segment, Word } from './types.js';

const log = logger('transcribe');

export interface WhisperStatus { reachable: boolean; ready: boolean; loading?: boolean; error?: string | null; busy?: boolean; model?: string }

export async function whisperStatus(): Promise<WhisperStatus> {
  if (!config.whisperUrl) return { reachable: false, ready: false, error: 'WHISPER_URL not set' };
  try {
    const r = await fetch(`${config.whisperUrl}/health`, { signal: AbortSignal.timeout(4000) });
    const j: any = await r.json().catch(() => ({}));
    // older whisper images answered {ok:true} without a "loaded" field
    const ready = j.loaded ?? j.ok ?? r.ok;
    return { reachable: true, ready: !!ready, loading: !!j.loading, error: j.error ?? null, busy: !!j.busy, model: j.model };
  } catch (e) {
    return { reachable: false, ready: false, error: errMsg(e) };
  }
}

export async function whisperHealthy(): Promise<boolean> {
  return (await whisperStatus()).ready;
}

async function transcribeWhisper(wavFile: string, offset: number, language: string): Promise<Segment[]> {
  const st = await whisperStatus();
  if (!st.ready) throw new Error(st.loading ? 'whisper model still loading' : `whisper not ready: ${st.error || 'unreachable'}`);
  const body = await fs.readFile(wavFile);
  const res = await fetch(`${config.whisperUrl}/transcribe?language=${encodeURIComponent(language || 'auto')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body,
    signal: AbortSignal.timeout(6 * 60 * 1000),
  });
  if (!res.ok) throw new Error(`whisper ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json: any = await res.json();
  return (json.segments || []).map((s: any) => ({
    start: s.start + offset,
    end: s.end + offset,
    text: String(s.text || '').trim(),
    words: (s.words || []).map((w: any) => ({ start: w.start + offset, end: w.end + offset, word: String(w.word).trim() })).filter((w: Word) => w.word),
  }));
}

/**
 * Transcribe a WAV file whose t=0 corresponds to session time `offset`.
 * Preference: local Whisper -> Gemini -> none. Never throws (returns [] on failure) so analysis can continue.
 */
export async function transcribe(wavFile: string, offset: number, mode: 'whisper' | 'gemini' | 'none', language: string): Promise<Segment[]> {
  if (mode === 'none') return [];
  if (mode === 'whisper' && config.whisperUrl) {
    try {
      return await transcribeWhisper(wavFile, offset, language);
    } catch (e) {
      // don't spend Gemini quota on transcripts when Whisper is the chosen engine
      log.warn(`whisper unavailable, no transcript for this chunk: ${errMsg(e)}`);
      return [];
    }
  }
  if (mode === 'gemini' && geminiEnabled()) {
    try {
      return withWords(await transcribeGemini(wavFile, offset));
    } catch (e) {
      log.warn(`gemini transcription failed: ${errMsg(e)}`);
    }
  }
  return [];
}

/** Ensure every segment has word timings (distributes the segment duration by word length when missing). */
export function withWords(segments: Segment[]): Segment[] {
  return segments.map((s) => (s.words && s.words.length ? s : { ...s, words: distributeWords(s.text, s.start, s.end) }));
}

export function distributeWords(text: string, start: number, end: number): Word[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const weights = words.map((w) => Math.max(2, w.length) + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const span = Math.max(0.2, end - start);
  let t = start;
  return words.map((w, i) => {
    const d = (weights[i] / total) * span;
    const out = { start: t, end: t + d, word: w };
    t += d;
    return out;
  });
}
