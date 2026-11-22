import { useEffect, useState, type ReactNode } from 'react';
import { api, type ClipSummary, type ScoreBreakdown } from './api';
import { toast, useAction } from './hooks';

export const fmtTime = (sec: number | null | undefined) => {
  if (sec == null || !Number.isFinite(sec)) return '–';
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};
export const fmtDur = (sec: number | null | undefined) => (sec == null ? '–' : `${sec.toFixed(1)}s`);
export const fmtNum = (n: number | null | undefined) =>
  n == null ? '–' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);
export function timeAgo(iso: string | null | undefined) {
  if (!iso) return '–';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 0) return `in ${Math.round(-d / 60)}m`;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

const STATUS_TONE: Record<string, string> = {
  live: 'red', recording: 'red', offline: 'gray', paused: 'gray', processing: 'blue', completed: 'green', error: 'amber',
  queued: 'gray', rendering: 'blue', ready: 'violet', approved: 'green', rejected: 'gray', failed: 'amber', published: 'green',
  uploading: 'blue', scheduled: 'violet', new: 'violet', clipped: 'green', dismissed: 'gray',
};
export function Badge({ status, children }: { status: string; children?: ReactNode }) {
  return (
    <span className={`badge tone-${STATUS_TONE[status] || 'gray'}`}>
      {status === 'live' && <span className="dot pulse" />}
      {children ?? status}
    </span>
  );
}

const EVIDENCE_LABEL: Record<keyof ScoreBreakdown['evidence'], string> = {
  event: 'Clear event', novelty: 'Unusual', payoff: 'Payoff in clip', reaction: 'Reaction', standalone: 'Makes sense alone',
};

/** Multi-line explanation of an evidence-based score (also used as the badge tooltip). */
export function explainScore(value: number | null | undefined, b?: ScoreBreakdown | null): string {
  if (!b) return value == null ? 'Not rated' : `${value}/100 — old score: the AI's own guess (not evidence-based). Re-analyse the stream to get a real rating.`;
  const lines = [`${value}/100 — evidence-based`];
  for (const k of Object.keys(EVIDENCE_LABEL) as (keyof ScoreBreakdown['evidence'])[]) lines.push(`${'●'.repeat(b.evidence[k])}${'○'.repeat(3 - b.evidence[k])}  ${EVIDENCE_LABEL[k]}`);
  lines.push(`Measured audio/visual spike: ${Math.round(b.signal * 100)}%  (+${b.signalPoints})`);
  if (b.audience) lines.push(`YouTube "Most replayed" heat: ${Math.round(b.audience.heat * 100)}%  (+${b.audience.points})`);
  if (b.rank) lines.push(`Ranked #${b.rank.position} of ${b.rank.of} in this stream${b.rank.reason ? ` — ${b.rank.reason}` : ""}`);
  if (b.taste) lines.push(`Your ratings for "${b.taste.category}": ${b.taste.avgStars}★ avg over ${b.taste.n}  (${b.taste.points >= 0 ? '+' : ''}${b.taste.points})`);
  for (const n of b.notes) lines.push(`Note: ${n}`);
  if (b.aiGuess != null) lines.push(`(AI's own guess was ${b.aiGuess})`);
  return lines.join('\n');
}

export function Score({ value, size = 44, breakdown }: { value: number | null | undefined; size?: number; breakdown?: ScoreBreakdown | null }) {
  const v = Math.max(0, Math.min(100, value ?? 0));
  const tone = v >= 80 ? 'var(--hot)' : v >= 60 ? 'var(--warm)' : 'var(--muted)';
  const r = size / 2 - 4;
  const c = 2 * Math.PI * r;
  const legacy = value != null && breakdown === null;
  return (
    <div className={`score${legacy ? ' legacy' : ''}`} style={{ width: size, height: size }} title={explainScore(value, breakdown)}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--line)" strokeWidth="4" fill="none" />
        <circle cx={size / 2} cy={size / 2} r={r} stroke={tone} strokeWidth="4" fill="none" strokeDasharray={`${(v / 100) * c} ${c}`} strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <span style={{ fontSize: size * 0.32 }}>{value ?? '–'}</span>
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Empty({ icon = '✨', title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}

export function PageHead({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p className="muted">{sub}</p>}
      </div>
      {actions && <div className="row gap">{actions}</div>}
    </div>
  );
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="progress">
      <div style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
    </div>
  );
}

/** 1-5 ★ rating. Click a star to rate, click the same star again to clear. */
export function Stars({ value, onChange, size = 18, label = 'Your rating' }: { value: number | null | undefined; onChange: (stars: number | null) => void; size?: number; label?: string }) {
  const [hover, setHover] = useState(0);
  const shown = hover || value || 0;
  return (
    <span className="stars" role="radiogroup" aria-label={label} title={value ? `${label}: ${value}★ (click again to clear)` : `${label}: not rated`} onMouseLeave={() => setHover(0)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} star${n > 1 ? 's' : ''}`}
          className={n <= shown ? 'on' : ''} style={{ fontSize: size }}
          onMouseEnter={() => setHover(n)} onClick={(e) => { e.stopPropagation(); onChange(value === n ? null : n); }}
        >★</button>
      ))}
    </span>
  );
}

/** Compact one-line "why" under a moment: ●●○ per checklist item + spike. */
export function ScoreWhy({ breakdown }: { breakdown?: ScoreBreakdown | null }) {
  if (!breakdown) return <span className="muted small">old score (AI guess) — re-analyse for a real rating</span>;
  const e = breakdown.evidence;
  const item = (k: keyof ScoreBreakdown['evidence']) => (
    <span key={k} className="why-item" title={EVIDENCE_LABEL[k]}>{EVIDENCE_LABEL[k]} <b>{'●'.repeat(e[k])}<span className="dimdot">{'●'.repeat(3 - e[k])}</span></b></span>
  );
  return (
    <span className="score-why small">
      {(Object.keys(EVIDENCE_LABEL) as (keyof ScoreBreakdown['evidence'])[]).map(item)}
      <span className="why-item" title="Measured audio/visual spike inside the clip">Spike <b>{Math.round(breakdown.signal * 100)}%</b></span>
      {breakdown.rank && <span className="why-item" title="Compared with the other moments of this stream">Rank <b>#{breakdown.rank.position}/{breakdown.rank.of}</b></span>}
      {breakdown.audience && <span className="why-item" title="YouTube Most replayed">Replayed <b>{Math.round(breakdown.audience.heat * 100)}%</b></span>}
      {breakdown.taste && <span className="why-item" title="Adjustment from your star ratings">Your taste <b>{breakdown.taste.points >= 0 ? '+' : ''}{breakdown.taste.points}</b></span>}
    </span>
  );
}

/**
 * Reads the metadata out of an answer pasted from Claude / ChatGPT: the ```json block we asked for, any {...} JSON,
 * or as a last resort "Title: / Description: / Hashtags:" lines. Returns null when no title is found.
 */
export function parseChatAnswer(text: string): { title: string; description: string; hashtags: string[]; notes: string[] } | null {
  const fromObj = (o: any) => {
    if (!o || typeof o !== 'object' || !String(o.title || '').trim()) return null;
    const raw = Array.isArray(o.hashtags) ? o.hashtags : String(o.hashtags || '').split(/[\s,]+/);
    const hashtags = [...new Set(raw.map((t: any) => String(t).trim().replace(/^#*/, '#')).filter((t: string) => t.length > 1 && !/^#shorts$/i.test(t)))] as string[];
    return {
      title: String(o.title).replace(/\s+/g, ' ').trim(),
      description: String(o.description || '').trim(),
      hashtags: hashtags.slice(0, 5),
      notes: (Array.isArray(o.notes) ? o.notes : []).map(String).slice(0, 4),
    };
  };
  const candidates = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]);
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);
  for (const c of candidates) {
    try {
      // chat apps often put real line breaks inside JSON strings (strict JSON forbids them) and use smart quotes
      const fixed = c.replace(/[“”]/g, '"').replace(/"(?:[^"\\]|\\.)*"/g, (s) => s.replace(/\r/g, '').replace(/\n/g, '\\n').replace(/\t/g, '\\t'));
      const r = fromObj(JSON.parse(fixed));
      if (r) return r;
    } catch { /* try the next candidate */ }
  }
  // "Title: …", "**Title:** …", "**Title**: …"
  const line = (k: string) => text.match(new RegExp(`^\\s*\\**${k}\\**\\s*[:：]\\s*\\**\\s*(.+)$`, 'im'))?.[1]?.trim().replace(/^["“]|["”]$/g, '');
  return fromObj({ title: line('title'), description: line('description'), hashtags: (line('hashtags') || '').match(/#\w+/g) || [] });
}

/** Explicit publish step: only reachable for approved clips. */
export function PublishDialog({ clip, onClose, onDone }: { clip: Pick<ClipSummary, 'id' | 'title' | 'description' | 'hashtags'>; onClose: () => void; onDone: () => void }) {
  const [privacy, setPrivacy] = useState('public');
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState(() => {
    const d = new Date(Date.now() + 3 * 3600 * 1000);
    d.setMinutes(0, 0, 0);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  });
  const [title, setTitle] = useState(clip.title);
  const [desc, setDesc] = useState(clip.description || '');
  const [tags, setTags] = useState((clip.hashtags || []).join(' '));
  const [confirmed, setConfirmed] = useState(false);
  const { busy, run } = useAction();
  const enhancer = useAction();
  const copier = useAction();
  const [direction, setDirection] = useState('');
  const [chat, setChat] = useState<{ open: boolean; frames: number; copied: boolean; manualText?: string }>({ open: false, frames: 0, copied: false });
  const [answer, setAnswer] = useState('');
  const [ai, setAi] = useState<{ notes: string[]; source: string; before: { title: string; desc: string; tags: string } } | null>(null);
  const draft = () => ({ title, description: desc, hashtags: tags.split(/[\s,]+/).filter(Boolean), prompt: direction });

  // AI only suggests: fields stay editable, Undo restores the draft, nothing is uploaded until "Upload now".
  const apply = (r: { title: string; description: string; hashtags: string[]; notes?: string[] }, source: string) => {
    setAi({ notes: r.notes || [], source, before: ai?.before || { title, desc, tags } });
    setTitle(r.title.slice(0, 100));
    setDesc(r.description);
    setTags(r.hashtags.join(' '));
  };
  const enhance = () =>
    enhancer.run(async () => {
      const r = await api.post<{ title: string; description: string; hashtags: string[]; notes: string[]; provider: string; watched: boolean }>(
        `/api/clips/${clip.id}/enhance-publish`, draft(),
      );
      apply(r, `${r.provider === 'gemini' ? 'Gemini' : 'Ollama'}${r.watched ? ' after watching the clip' : ' (couldn’t load the video, used the transcript)'}`);
    });
  // 📋 your own Claude / ChatGPT chat (subscription, no API credits): copy prompt → paste into the chat → paste the answer back
  const copyPrompt = () =>
    copier.run(async () => {
      const r = await api.post<{ text: string; frames: number }>(`/api/clips/${clip.id}/publish-prompt`, draft());
      let copied = false;
      try {
        await navigator.clipboard.writeText(r.text);
        copied = true;
      } catch { /* clipboard blocked: show the text to copy by hand */ }
      setChat({ open: true, frames: r.frames, copied, manualText: copied ? undefined : r.text });
      if (copied) toast('Prompt copied — paste it into Claude or ChatGPT');
    });
  const applyAnswer = () => {
    const r = parseChatAnswer(answer);
    if (!r) return toast('Couldn’t find a title in that answer — paste the whole reply, including the ```json block', 'err');
    apply(r, 'your Claude/ChatGPT chat');
    setAnswer('');
    setChat((c) => ({ ...c, open: false }));
  };
  const undo = () => {
    if (!ai) return;
    setTitle(ai.before.title);
    setDesc(ai.before.desc);
    setTags(ai.before.tags);
    setAi(null);
  };

  const submit = () =>
    run(async () => {
      await api.post(`/api/clips/${clip.id}/publish`, {
        privacy,
        publishAt: when === 'later' ? new Date(at).toISOString() : undefined,
        title,
        description: desc,
        hashtags: tags.split(/[\s,]+/).filter(Boolean),
      });
      toast(when === 'later' ? 'Scheduled — uploading now, YouTube will publish it at the chosen time' : 'Added to the publishing queue');
      onDone();
      onClose();
    });

  return (
    <Modal title="Publish to YouTube Shorts" onClose={onClose}>
      <div className="form">
        <label>What happens / what to focus on <span className="muted small">(optional — the AI builds the title, description and hashtags around it)</span>
          <input value={direction} maxLength={500} onChange={(e) => setDirection(e.target.value)} placeholder="e.g. jet crashes into the cop helicopter, make it funny" />
        </label>
        <div className="row gap wrap">
          <button className="btn" disabled={enhancer.busy || busy} onClick={enhance}>
            {enhancer.busy ? '✨ Watching the clip…' : ai ? '✨ Enhance again' : '✨ Enhance with AI'}
          </button>
          <button className="btn" disabled={copier.busy || busy} onClick={copyPrompt} title="Free with your Claude Pro / ChatGPT subscription — no API credits">
            {copier.busy ? '📋 Preparing…' : '📋 Copy for Claude/ChatGPT'}
          </button>
          {ai && <button className="btn ghost sm" disabled={enhancer.busy} onClick={undo}>↶ Undo</button>}
        </div>
        <span className="muted small">
          {ai
            ? `Suggested by ${ai.source} — check it before uploading.`
            : '✨ uses the free AI in this app (Gemini free tier / Ollama). 📋 uses your own Claude or ChatGPT chat.'}
        </span>
        {chat.open && (
          <div className="card" style={{ padding: 12 }}>
            <ol className="small" style={{ margin: '0 0 8px', paddingLeft: 18 }}>
              <li>{chat.copied ? 'Prompt copied. ' : 'Copy the prompt below. '}Open <a href="https://claude.ai/new" target="_blank" rel="noreferrer">Claude ↗</a> or <a href="https://chatgpt.com/" target="_blank" rel="noreferrer">ChatGPT ↗</a> and paste it.</li>
              {chat.frames > 0 && (
                <li><a href={`/api/clips/${clip.id}/publish-frames.jpg`} download>🖼 Download the frame grid</a> ({chat.frames} frames) and attach it to the same message, so the AI can see the clip.</li>
              )}
              <li>Paste the AI’s whole answer here, then press Apply.</li>
            </ol>
            {chat.manualText && <textarea rows={4} readOnly value={chat.manualText} onFocus={(e) => e.currentTarget.select()} />}
            <textarea rows={4} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Paste the AI's answer (with the ```json block) here" />
            <div className="row end gap" style={{ marginTop: 8 }}>
              <button className="btn ghost sm" onClick={() => setChat((c) => ({ ...c, open: false }))}>Close</button>
              <button className="btn primary sm" disabled={!answer.trim()} onClick={applyAnswer}>Apply answer</button>
            </div>
          </div>
        )}
        {ai && ai.notes.length > 0 && (
          <ul className="muted small" style={{ margin: 0, paddingLeft: 18 }}>
            {ai.notes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        )}
        <label>Title <span className="muted small">({title.length}/100)</span><input value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} /></label>
        <label>Description<textarea rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
        <label>Hashtags<input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="#GTA6 #Shorts" /></label>
        <div className="grid2">
          <label>Visibility
            <select value={privacy} onChange={(e) => setPrivacy(e.target.value)} disabled={when === 'later'}>
              <option value="public">Public</option>
              <option value="unlisted">Unlisted</option>
              <option value="private">Private</option>
            </select>
          </label>
          <label>When
            <select value={when} onChange={(e) => setWhen(e.target.value as any)}>
              <option value="now">Publish now</option>
              <option value="later">Schedule</option>
            </select>
          </label>
        </div>
        {when === 'later' && <label>Publish at (your local time)<input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></label>}
        <label className="check">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          I reviewed this clip and approve uploading it to my channel. I have the rights to publish this content.
        </label>
        <div className="row end gap">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!confirmed || busy || !title.trim()} onClick={submit}>{busy ? 'Queuing…' : when === 'later' ? 'Schedule upload' : 'Upload now'}</button>
        </div>
      </div>
    </Modal>
  );
}
