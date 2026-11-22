/**
 * Local vision model through Ollama (runs on your PC, free, no quota).
 * Ollama can't take video, so we send a handful of still frames + the Whisper transcript + audio spikes.
 * Default model: qwen2.5vl:3b (set OLLAMA_MODEL or Settings → AI provider to change).
 */
import { config } from '../../config.js';
import { runBuffer } from '../../lib/proc.js';
import { logger } from '../../lib/log.js';

const log = logger('ollama');
let modelOverride = '';
export const setOllamaModelOverride = (m: string) => {
  modelOverride = (m || '').trim();
};
export const activeOllamaModel = () => modelOverride || config.ollama.model;

/** Gemini-style schema (OBJECT/STRING…) -> JSON schema for Ollama structured outputs. */
export function toJsonSchema(s: any): any {
  if (!s || typeof s !== 'object') return s;
  const out: any = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'type' && typeof v === 'string') out.type = v.toLowerCase();
    else if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v as any).map(([pk, pv]) => [pk, toJsonSchema(pv)]));
    else if (k === 'items') out.items = toJsonSchema(v);
    else out[k] = v;
  }
  return out;
}

export interface OllamaStatus { reachable: boolean; ready: boolean; model: string; models: string[]; error?: string }
let statusCache: { at: number; value: OllamaStatus } | null = null;

export async function ollamaStatus(force = false): Promise<OllamaStatus> {
  if (!force && statusCache && Date.now() - statusCache.at < 30_000) return statusCache.value;
  const model = activeOllamaModel();
  let value: OllamaStatus;
  if (!config.ollama.url) value = { reachable: false, ready: false, model, models: [], error: 'OLLAMA_URL not set' };
  else {
    try {
      const r = await fetch(`${config.ollama.url}/api/tags`, { signal: AbortSignal.timeout(4000) });
      const j: any = await r.json();
      const models: string[] = (j.models || []).map((m: any) => m.name);
      const ready = models.some((n) => n === model || n === `${model}:latest` || n.split(':')[0] === model);
      value = { reachable: true, ready, model, models, error: ready ? undefined : `model "${model}" not pulled (run: ollama pull ${model})` };
    } catch (e: any) {
      value = { reachable: false, ready: false, model, models: [], error: `can't reach Ollama at ${config.ollama.url} (${e?.message || e})` };
    }
  }
  statusCache = { at: Date.now(), value };
  return value;
}

export async function ollamaJson(prompt: string, imagesB64: string[], schema: any, temperature = 0.3): Promise<any> {
  const model = activeOllamaModel();
  const res = await fetch(`${config.ollama.url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      format: schema ? toJsonSchema(schema) : 'json',
      options: { temperature, num_ctx: 16384, num_predict: 3000 }, // room for the per-moment evidence checklist
      keep_alive: '30m',
      messages: [{ role: 'user', content: prompt, ...(imagesB64.length ? { images: imagesB64 } : {}) }],
    }),
    signal: AbortSignal.timeout(8 * 60 * 1000),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j: any = await res.json();
  const text: string = j.message?.content || '';
  log.debug(`ollama ${model}: ${j.eval_count ?? '?'} tokens in ${((j.total_duration || 0) / 1e9).toFixed(1)}s`);
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Ollama returned invalid JSON');
  }
}

/** Grab still frames (JPEG, base64) at the given seconds of a media file. */
export async function grabFrames(file: string, times: number[], width = 448): Promise<string[]> {
  const out: string[] = [];
  for (const t of times) {
    try {
      const buf = await runBuffer(config.ffmpegBin, [
        '-hide_banner', '-nostdin', '-v', 'error', '-ss', Math.max(0, t).toFixed(2), '-i', file,
        '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '5', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-',
      ]);
      if (buf.length) out.push(buf.toString('base64'));
    } catch {
      /* skip unreadable frame */
    }
  }
  return out;
}

/**
 * One "contact sheet" image (3x2 grid, read left→right, top→bottom) instead of many frames.
 * Vision models charge ~1k tokens per image, so a single sheet is ~5x faster on a home GPU.
 */
export async function contactSheet(file: string, times: number[], cols = 3, cellW = 384, rows = 2): Promise<string[]> {
  const sheets: string[] = [];
  const per = cols * rows;
  for (let i = 0; i < times.length; i += per) {
    const group = times.slice(i, i + per);
    // exactly one frame per time: the first frame at/after t (a ±window would pick ~15 frames at 60 fps, and tile
    // would fill all 6 cells from the first window). Times are sorted & distinct, so the terms never overlap.
    const sel = group
      .map((t) => t.toFixed(2))
      .map((t) => `gte(t,${t})*(isnan(prev_selected_t)+lt(prev_selected_t,${t}))`)
      .join('+');
    const cellH = Math.round((cellW * 9) / 16 / 2) * 2;
    try {
      const buf = await runBuffer(config.ffmpegBin, [
        '-hide_banner', '-nostdin', '-v', 'error', '-i', file,
        '-vf', `setpts=PTS-STARTPTS,select='${sel}',scale=${cellW}:${cellH},tile=${cols}x${Math.ceil(group.length / cols)}:padding=4:color=black`,
        '-frames:v', '1', '-q:v', '4', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-',
      ]);
      if (buf.length) sheets.push(buf.toString('base64'));
    } catch {
      /* fall back below */
    }
  }
  return sheets.length ? sheets : grabFrames(file, times.slice(0, 2));
}

/** Evenly spaced frame times plus the strongest spikes (so the model sees the action), max `n`. */
export function frameTimes(duration: number, peaks: number[], n = 8): number[] {
  const even = Math.max(2, n - Math.min(3, peaks.length));
  const times = Array.from({ length: even }, (_, i) => ((i + 0.5) * duration) / even);
  for (const p of peaks.slice(0, n - even)) times.push(Math.min(duration - 0.2, Math.max(0, p)));
  return [...new Set(times.map((t) => Math.round(t * 2) / 2))].sort((a, b) => a - b).slice(0, n);
}
