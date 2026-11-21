export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error || res.statusText);
  return data as T;
}

export const api = {
  get: <T = any>(u: string) => req<T>('GET', u),
  post: <T = any>(u: string, b: unknown = {}) => req<T>('POST', u, b),
  put: <T = any>(u: string, b: unknown) => req<T>('PUT', u, b),
  patch: <T = any>(u: string, b: unknown) => req<T>('PATCH', u, b),
  del: <T = any>(u: string) => req<T>('DELETE', u),
  upload(file: File, name: string, onProgress: (pct: number) => void): Promise<any> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/streams/upload?permission=1&name=${encodeURIComponent(name)}&filename=${encodeURIComponent(file.name)}`);
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
      xhr.onload = () => {
        const data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
        xhr.status < 300 ? resolve(data) : reject(new ApiError(xhr.status, data?.error || 'upload failed'));
      };
      xhr.onerror = () => reject(new ApiError(0, 'network error'));
      xhr.send(file);
    });
  },
};

// ---- types (subset of DB rows the UI uses) ----
export interface Stream {
  id: string; name: string; url: string | null; kind: 'live' | 'channel' | 'vod' | 'file'; status: string; paused: boolean;
  source_title: string | null; last_error: string | null; last_checked_at: string | null; options: any;
  chunk_count: number; pending_chunks: number; recorded_seconds: number; moment_count: number; clip_count: number; live_since: string | null; created_at: string;
}
export interface Moment {
  id: string; stream_id: string; stream_name: string; stream_url: string | null; session_title: string | null; start_sec: number; end_sec: number; peak_sec: number | null;
  title: string; description: string | null; category: string | null; score: number; hashtags: string[]; keywords: string[]; transcript: string | null;
  detector: string; status: string; created_at: string; clip_id: string | null; clip_status: string | null;
}
export interface Publication {
  id: string; clip_id: string; status: string; privacy: string; publish_at: string | null; title: string; description: string | null; tags: string[];
  youtube_video_id: string | null; progress: number; attempts: number; error: string | null; stats: any; stats_updated_at: string | null; created_at: string;
  has_thumb?: boolean; duration?: number; category?: string; stream_name?: string;
}
export interface ClipSummary {
  id: string; status: string; title: string; description: string | null; hashtags: string[]; score: number | null; category: string | null; duration: number | null;
  start_sec: number; end_sec: number; progress: number; error: string | null; created_at: string; updated_at: string; approved_at: string | null; version: number;
  has_thumb: boolean; has_video: boolean; kind?: 'single' | 'mission'; stream_name: string | null; stream_url: string | null; publication: Partial<Publication> | null;
}
export interface Segment { start: number; end: number; text: string; words?: { start: number; end: number; word: string }[] }
export interface ClipDetail extends ClipSummary {
  session_id: string | null; moment_id: string | null; captions: { segments: Segment[]; edited?: boolean } | null; options: any; reject_reason: string | null;
  stream_kind: string | null; stream_options: any; session_title: string | null; peak_sec: number | null; moment_transcript: string | null; detector: string | null;
  keywords: string[] | null; available_start: number | null; available_end: number | null; publications: Publication[];
  edit_plan: EditPlan | null;
  parts: { start: number; end: number; momentIds?: string[] }[] | null;
}
export interface EditPlan {
  hook: string; keywords: string[]; captions?: Segment[]; sfx: { t: number; type: string }[];
  source: 'gemini' | 'heuristic' | 'user'; createdAt: string; userEdited?: boolean;
}

export const clipVideoUrl = (c: { id: string; version?: number; updated_at?: string }) => `/api/clips/${c.id}/video?v=${c.version ?? ''}-${c.updated_at ?? ''}`;
export const clipThumbUrl = (c: { id: string; version?: number; updated_at?: string }) => `/api/clips/${c.id}/thumb?v=${c.version ?? ''}-${c.updated_at ?? ''}`;
