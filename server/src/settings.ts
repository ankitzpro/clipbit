import { one, q } from './db/pool.js';
import { defaultSettings, type AppSettings } from './settings-defaults.js';
import { setGeminiModelOverride } from './services/ai/gemini.js';
import { setOllamaModelOverride } from './services/ai/ollama.js';

export * from './settings-defaults.js';

function deepMerge<T>(base: T, over: any): T {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return (over ?? base) as T;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(over)) {
    const b = (base as any)?.[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) && v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(b, v) : v;
  }
  return out;
}

let cache: { at: number; value: AppSettings } | null = null;

export async function getSettings(): Promise<AppSettings> {
  if (cache && Date.now() - cache.at < 5000) return cache.value;
  const row = await one<{ value: any }>(`SELECT value FROM settings WHERE key = 'app'`);
  const value = deepMerge(defaultSettings, row?.value || {});
  setGeminiModelOverride(value.geminiModel);
  setOllamaModelOverride(value.ollamaModel);
  cache = { at: Date.now(), value };
  return value;
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings();
  const next = deepMerge(current, patch);
  next.clipMin = Math.max(5, Math.min(next.clipMin, 60));
  next.clipMax = Math.max(next.clipMin, Math.min(next.clipMax, 180));
  next.chunkSeconds = Math.max(30, Math.min(next.chunkSeconds, 180));
  await q(`INSERT INTO settings(key, value) VALUES ('app', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(next)]);
  cache = null;
  setGeminiModelOverride(next.geminiModel);
  setOllamaModelOverride(next.ollamaModel);
  return next;
}

/** Persist Gemini's last success/failure so the dashboard (other container) can show it. */
export async function recordAiHealth(h: unknown) {
  await q(`INSERT INTO settings(key, value) VALUES ('ai_health', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(h)]);
}
export async function getAiHealth(): Promise<any> {
  return (await one<{ value: any }>(`SELECT value FROM settings WHERE key = 'ai_health'`))?.value || null;
}
