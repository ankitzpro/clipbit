import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

/** Fetch a URL and re-poll every `intervalMs` (0 = no polling). Pauses while the tab is hidden. */
export function usePoll<T>(url: string | null, intervalMs = 4000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const urlRef = useRef(url);
  urlRef.current = url;

  const load = useCallback(async () => {
    if (!urlRef.current) return;
    try {
      const d = await api.get<T>(urlRef.current);
      setData(d);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void load();
    if (!intervalMs) return;
    const t = setInterval(() => {
      if (!document.hidden) void load();
    }, intervalMs);
    return () => clearInterval(t);
  }, [url, intervalMs, load]);

  return { data, error, loading, reload: load, setData };
}

/** Minimal hash router: #/path?query */
export function useRoute() {
  const parse = () => {
    const h = window.location.hash.replace(/^#/, '') || '/';
    const [path, qs] = h.split('?');
    return { path, query: new URLSearchParams(qs || '') };
  };
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const navigate = (to: string) => {
  window.location.hash = to;
};

// --- toast notifications ---
type Toast = { id: number; text: string; kind: 'ok' | 'err' };
let listeners: ((t: Toast[]) => void)[] = [];
let toasts: Toast[] = [];
export function toast(text: string, kind: 'ok' | 'err' = 'ok') {
  const t = { id: Date.now() + Math.random(), text, kind };
  toasts = [...toasts, t];
  listeners.forEach((l) => l(toasts));
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    listeners.forEach((l) => l(toasts));
  }, kind === 'err' ? 7000 : 3500);
}
export function useToasts() {
  const [list, setList] = useState<Toast[]>(toasts);
  useEffect(() => {
    listeners.push(setList);
    return () => {
      listeners = listeners.filter((l) => l !== setList);
    };
  }, []);
  return list;
}

/** Wrap an async action: shows errors as toasts, tracks busy state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, okMsg?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      const r = await fn();
      if (okMsg) toast(okMsg);
      return r;
    } catch (e: any) {
      toast(e.message || String(e), 'err');
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, run };
}
