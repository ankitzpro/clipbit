import { useEffect, useRef, useState } from 'react';
import { api, clipThumbUrl, clipVideoUrl, type ClipDetail, type ClipSummary, type Segment } from '../api';
import { AiEditPanel } from './AiEdit';
import { navigate, toast, useAction, usePoll } from '../hooks';
import { Badge, Empty, PageHead, Progress, PublishDialog, Score, ScoreWhy, Stars, fmtDur, fmtTime, timeAgo } from '../ui';

export function Studio({ clipId }: { clipId?: string }) {
  return clipId ? <ClipEditor id={clipId} /> : <ClipBrowser />;
}

const fmtMB = (bytes: number) => (bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(1)} GB` : `${Math.max(0.1, bytes / 1048576).toFixed(1)} MB`);

function ClipBrowser() {
  const [status, setStatus] = useState('');
  const { data, reload } = usePoll<ClipSummary[]>(`/api/clips?limit=200${status ? `&status=${status}` : ''}`, 5000);
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const { busy, run } = useAction();
  // leftover files of clips deleted before disk cleanup existed
  const { data: orphans, reload: reloadOrphans } = usePoll<{ count: number; bytes: number; supported: boolean }>('/api/storage/orphans', 60000);
  const cleaner = useAction();
  const cleanOrphans = () =>
    cleaner.run(async () => {
      const r = await api.post<{ deleted: number; freedBytes: number }>('/api/storage/orphans/clean');
      toast(`Cleaned up ${r.deleted} leftover item${r.deleted === 1 ? '' : 's'} · freed ${fmtMB(r.freedBytes)} on disk`);
      await reloadOrphans();
    });

  const visible = data || [];
  // keep only ids still on screen (filter changed / clip disappeared)
  const chosen = visible.filter((c) => sel.has(c.id));
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const exitSelect = () => { setSelecting(false); setSel(new Set()); setConfirming(false); };
  const published = chosen.filter((c) => c.status === 'published').length;
  const busyCount = chosen.filter((c) => c.status === 'rendering' || c.status === 'queued').length;

  const doDelete = () =>
    run(async () => {
      const r = await api.post<{ deleted: number; freedBytes: number; skipped: { title: string; reason: string }[] }>('/api/clips/bulk-delete', { ids: chosen.map((c) => c.id) });
      toast(`Deleted ${r.deleted} clip${r.deleted === 1 ? '' : 's'} · freed ${fmtMB(r.freedBytes)} on disk${r.skipped.length ? ` · skipped ${r.skipped.length} (${[...new Set(r.skipped.map((s) => s.reason))].join(', ')})` : ''}`);
      exitSelect();
      await Promise.all([reload(), reloadOrphans()]);
    });

  return (
    <>
      <PageHead
        title="Clip Studio"
        sub="Preview, trim, reframe and caption any generated clip."
        actions={visible.length > 0 && (selecting
          ? <button className="btn sm ghost" onClick={exitSelect}>Cancel</button>
          : <button className="btn sm" onClick={() => setSelecting(true)}>☑ Select clips</button>)}
      />
      {orphans?.supported && orphans.count > 0 && (
        <div className="card row gap wrap" style={{ padding: '10px 14px' }}>
          <span className="grow small">
            🧹 <b>{fmtMB(orphans.bytes)}</b> on disk belongs to clips that were already deleted ({orphans.count} leftover folder{orphans.count === 1 ? '' : 's'}/preview{orphans.count === 1 ? '' : 's'}).
            <span className="muted"> Your existing clips are not touched.</span>
          </span>
          <button className="btn sm" disabled={cleaner.busy} onClick={cleanOrphans}>{cleaner.busy ? 'Cleaning…' : 'Clean up'}</button>
        </div>
      )}
      <div className="filters">
        {['', 'rendering,queued', 'ready', 'approved', 'published', 'rejected', 'failed'].map((s) => (
          <button key={s} className={`btn sm ${status === s ? 'primary' : 'ghost'}`} onClick={() => { setStatus(s); setSel(new Set()); setConfirming(false); }}>{s ? s.split(',')[0] : 'all'}</button>
        ))}
      </div>
      {selecting && (
        <div className="card select-bar">
          <div className="row gap wrap">
            <b>{chosen.length} selected</b>
            <button className="btn sm ghost" onClick={() => setSel(new Set(visible.map((c) => c.id)))}>Select all {visible.length}</button>
            {chosen.length > 0 && <button className="btn sm ghost" onClick={() => setSel(new Set())}>Clear</button>}
            <span className="grow" />
            {!confirming
              ? <button className="btn sm danger" disabled={!chosen.length} onClick={() => setConfirming(true)}>🗑 Delete {chosen.length || ''}…</button>
              : (
                <>
                  <button className="btn sm ghost" disabled={busy} onClick={() => setConfirming(false)}>Keep them</button>
                  <button className="btn sm danger primary" disabled={busy} onClick={doDelete}>{busy ? 'Deleting…' : `Yes, delete ${chosen.length} permanently`}</button>
                </>
              )}
          </div>
          {confirming && (
            <ul className="small" style={{ margin: '8px 0 0', paddingLeft: 18 }}>
              <li>Removes the clips from ClipBit <b>and their video files from your disk</b> (all versions, thumbnails, previews). This can’t be undone.</li>
              {published > 0 && <li className="warn">{published} of them {published === 1 ? 'is' : 'are'} published: the video stays on YouTube, but its upload history and stats disappear from ClipBit.</li>}
              {busyCount > 0 && <li className="muted">{busyCount} still rendering will be skipped.</li>}
              <li className="muted">The detected moments stay, so you can generate these clips again later.</li>
            </ul>
          )}
        </div>
      )}
      {!data ? null : data.length === 0 ? (
        <Empty icon="🎬" title="No clips">Generate one from Detected Moments.</Empty>
      ) : (
        <div className="clip-grid">
          {data.map((c) => (
            <ClipCard
              key={c.id}
              c={c}
              selected={selecting ? sel.has(c.id) : undefined}
              onClick={() => (selecting ? toggle(c.id) : navigate(`/studio/${c.id}`))}
            />
          ))}
        </div>
      )}
    </>
  );
}

export function ClipCard({ c, onClick, children, selected }: { c: ClipSummary; onClick?: () => void; children?: React.ReactNode; selected?: boolean }) {
  const busy = c.status === 'rendering' || c.status === 'queued';
  return (
    <div className={`clip-card card${selected ? ' selected' : ''}`}>
      <div className="clip-thumb" onClick={onClick}>
        {selected !== undefined && <span className={`select-box${selected ? ' on' : ''}`} aria-label={selected ? 'selected' : 'not selected'}>{selected ? '✓' : ''}</span>}
        {c.has_thumb && !busy ? <img src={clipThumbUrl(c)} alt="" loading="lazy" /> : <div className="thumb-ph">{busy ? `Rendering ${c.progress}%` : c.status}</div>}
        {c.duration != null && <span className="dur">{fmtDur(c.duration)}</span>}
        <span className="score-badge">{c.score ?? '–'}</span>
      </div>
      <div className="clip-meta">
        <div className="row gap"><Badge status={c.status} />{c.category && <span className="chip">{c.category}</span>}</div>
        <b className="ellipsis2" onClick={onClick}>{c.title}</b>
        <div className="muted small">{c.stream_name} · {timeAgo(c.created_at)}</div>
        {busy && <Progress value={c.progress} />}
        {c.error && <div className="small warn ellipsis2">{c.error}</div>}
        {children}
      </div>
    </div>
  );
}

function ClipEditor({ id }: { id: string }) {
  const { data: clip, reload } = usePoll<ClipDetail>(`/api/clips/${id}`, 3000);
  const [publishing, setPublishing] = useState(false);
  const { busy, run } = useAction();
  if (!clip) return <PageHead title="Clip Studio" sub="Loading…" />;

  const rendering = clip.status === 'rendering' || clip.status === 'queued';
  const act = (fn: () => Promise<any>, msg?: string) => run(async () => { await fn(); await reload(); }, msg);

  return (
    <>
      <PageHead
        title="Clip Studio"
        sub={<><a href="#/studio">← All clips</a> · {clip.stream_name} · {clip.session_title}</>}
        actions={
          <>
            {clip.has_video && <a className="btn ghost" href={`/api/clips/${clip.id}/download`}>⬇ Download</a>}
            {(clip.status === 'ready' || clip.status === 'rejected') && <button className="btn primary" disabled={busy} onClick={() => act(() => api.post(`/api/clips/${clip.id}/approve`), 'Approved')}>✓ Approve</button>}
            {clip.status === 'approved' && <button className="btn primary" onClick={() => setPublishing(true)}>🚀 Publish…</button>}
            {clip.status === 'approved' && <button className="btn ghost" onClick={() => act(() => api.post(`/api/clips/${clip.id}/unapprove`), 'Moved back to review')}>Undo approval</button>}
            {['ready', 'approved', 'failed'].includes(clip.status) && (
              <button className="btn ghost danger" onClick={() => { const r = prompt('Why reject this clip? (helps the AI learn — optional)'); if (r !== null) act(() => api.post(`/api/clips/${clip.id}/reject`, { reason: r }), 'Rejected'); }}>✕ Reject</button>
            )}
          </>
        }
      />
      <div className="studio">
        <div className="studio-left">
          <div className="phone">
            {rendering ? (
              <div className="phone-busy"><div className="spinner" /><div>Rendering… {clip.progress}%</div><Progress value={clip.progress} /></div>
            ) : clip.has_video ? (
              <video key={clip.version + clip.updated_at} src={clipVideoUrl(clip)} controls playsInline loop poster={clip.has_thumb ? clipThumbUrl(clip) : undefined} />
            ) : (
              <div className="phone-busy">{clip.error || 'No video'}</div>
            )}
          </div>
          <div className="row gap center">
            <Badge status={clip.status} />
            <Score value={clip.score} size={36} breakdown={clip.score_breakdown ?? null} />
            <Stars value={clip.user_rating} onChange={(st) => act(() => api.post(`/api/clips/${clip.id}/rating`, { stars: st }), st ? `Rated ${st}★` : 'Rating cleared')} />
            <span className="muted small">{fmtDur(clip.duration)} · v{clip.version}</span>
          </div>
          <ScoreWhy breakdown={clip.score_breakdown ?? null} />
          {clip.error && <div className="small warn">{clip.error}</div>}
          {clip.reject_reason && <div className="small muted">Rejected: {clip.reject_reason}</div>}
        </div>
        <div className="studio-right">
          <MetaPanel clip={clip} onSaved={reload} />
          <AiEditPanel clip={clip} onQueued={reload} />
          {clip.kind === 'mission' && clip.parts ? (
            <section className="card">
              <h3>Mission Short · {clip.parts.length} parts</h3>
              {clip.parts.map((p, i) => (
                <div key={i} className="muted small">{i + 1}. {fmtTime(p.start)}–{fmtTime(p.end)} ({Math.round(p.end - p.start)}s)</div>
              ))}
              <p className="muted small">To change which moments are included, create a new mission Short from the Missions page.</p>
            </section>
          ) : (
            <TrimPanel clip={clip} onQueued={reload} />
          )}
          <CaptionPanel clip={clip} onQueued={reload} />
          <section className="card">
            <h3>Why the AI picked this</h3>
            <p className="desc">{clip.description || '—'}</p>
            {clip.moment_transcript && <p className="transcript">“{clip.moment_transcript}”</p>}
            <div className="muted small">Detector: {clip.detector === 'gemini' ? 'Gemini multimodal' : 'audio/visual signals'} · source {fmtTime(clip.start_sec)}–{fmtTime(clip.end_sec)}{clip.stream_url && <> · <a href={clip.stream_url} target="_blank" rel="noreferrer">original stream</a></>}</div>
          </section>
          {clip.publications.length > 0 && (
            <section className="card">
              <h3>Publishing</h3>
              {clip.publications.map((p) => (
                <div key={p.id} className="row gap">
                  <Badge status={p.status} />
                  {p.youtube_video_id ? <a href={`https://youtube.com/shorts/${p.youtube_video_id}`} target="_blank" rel="noreferrer">youtube.com/shorts/{p.youtube_video_id}</a> : <span className="muted small">{p.error || `${p.progress}%`}</span>}
                </div>
              ))}
            </section>
          )}
          <div className="row end"><button className="btn sm ghost danger" onClick={() => confirm('Delete this clip permanently?') && act(async () => { await api.del(`/api/clips/${clip.id}`); navigate('/studio'); }, 'Deleted')}>Delete clip</button></div>
        </div>
      </div>
      {publishing && <PublishDialog clip={clip} onClose={() => setPublishing(false)} onDone={reload} />}
    </>
  );
}

function MetaPanel({ clip, onSaved }: { clip: ClipDetail; onSaved: () => void }) {
  const [title, setTitle] = useState(clip.title);
  const [desc, setDesc] = useState(clip.description || '');
  const [tags, setTags] = useState(clip.hashtags.join(' '));
  const { busy, run } = useAction();
  useEffect(() => {
    setTitle(clip.title);
    setDesc(clip.description || '');
    setTags(clip.hashtags.join(' '));
  }, [clip.id]);
  const dirty = title !== clip.title || desc !== (clip.description || '') || tags !== clip.hashtags.join(' ');
  return (
    <section className="card">
      <div className="card-head"><h3>Title & description</h3>
        <button className="btn sm ghost" disabled={busy} onClick={() => run(async () => {
          const m = await api.post(`/api/clips/${clip.id}/regenerate-metadata`);
          setTitle(m.title); setDesc(m.description); setTags(m.hashtags.join(' '));
        }, 'New AI suggestion — review and save')}>✨ AI rewrite</button>
      </div>
      <div className="form">
        <label>Title <span className="muted small">({title.length}/100)</span><input value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} /></label>
        <label>Description<textarea rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
        <label>Hashtags<input value={tags} onChange={(e) => setTags(e.target.value)} /></label>
        <div className="row end"><button className="btn sm primary" disabled={!dirty || busy} onClick={() => run(async () => { await api.patch(`/api/clips/${clip.id}`, { title, description: desc, hashtags: tags.split(/[\s,]+/).filter(Boolean) }); onSaved(); }, 'Saved')}>Save</button></div>
      </div>
    </section>
  );
}

function TrimPanel({ clip, onQueued }: { clip: ClipDetail; onQueued: () => void }) {
  const [start, setStart] = useState(clip.start_sec);
  const [end, setEnd] = useState(clip.end_sec);
  const [mode, setMode] = useState(clip.options?.reframeMode || 'smart');
  const [captions, setCaptions] = useState(clip.options?.captions ?? true);
  const [deadAir, setDeadAir] = useState(clip.options?.deadAir ?? true);
  const { data: branding } = usePoll<{ slot: 'intro' | 'outro'; enabled: boolean; exists: boolean; duration: number | null }[]>('/api/branding', 0);
  const brand = (slot: 'intro' | 'outro') => branding?.find((b) => b.slot === slot);
  const introDefault = clip.options?.intro ?? brand('intro')?.enabled ?? false;
  const outroDefault = clip.options?.outro ?? brand('outro')?.enabled ?? false;
  const [intro, setIntro] = useState<boolean | null>(null);
  const [outro, setOutro] = useState<boolean | null>(null);
  const introOn = intro ?? introDefault;
  const outroOn = outro ?? outroDefault;
  const [showSource, setShowSource] = useState(false);
  const vref = useRef<HTMLVideoElement>(null);
  const { busy, run } = useAction();
  useEffect(() => {
    setStart(clip.start_sec);
    setEnd(clip.end_sec);
  }, [clip.id, clip.version]);

  const avA = clip.available_start ?? clip.start_sec;
  const avB = clip.available_end ?? clip.end_sec;
  const srcFrom = Math.max(avA, Math.floor(clip.start_sec - 20));
  const srcTo = Math.min(avB, Math.ceil(clip.end_sec + 20));
  const cur = () => srcFrom + (vref.current?.currentTime || 0);
  const len = end - start;
  const changed = start !== clip.start_sec || end !== clip.end_sec || mode !== (clip.options?.reframeMode || 'smart') || captions !== (clip.options?.captions ?? true) || deadAir !== (clip.options?.deadAir ?? true) || introOn !== introDefault || outroOn !== outroDefault;

  const nudge = (which: 'start' | 'end', d: number) => (which === 'start' ? setStart((v) => +(Math.max(avA, v + d)).toFixed(2)) : setEnd((v) => +(Math.min(avB, v + d)).toFixed(2)));

  return (
    <section className="card">
      <div className="card-head"><h3>Trim & framing</h3><button className="btn sm ghost" onClick={() => setShowSource(!showSource)}>{showSource ? 'Hide' : 'Show'} original footage</button></div>
      {showSource && (
        <div className="source">
          <video ref={vref} src={`/api/clips/${clip.id}/source?from=${srcFrom}&to=${srcTo}`} controls playsInline />
          <div className="row gap wrap">
            <button className="btn sm" onClick={() => setStart(+cur().toFixed(2))}>⇤ Set start here</button>
            <button className="btn sm" onClick={() => setEnd(+cur().toFixed(2))}>Set end here ⇥</button>
            <button className="btn sm ghost" onClick={() => vref.current && (vref.current.currentTime = start - srcFrom)}>Jump to start</button>
            <span className="muted small">Preview covers {fmtTime(srcFrom)}–{fmtTime(srcTo)} of the stream</span>
          </div>
        </div>
      )}
      <div className="trim">
        <div>
          <div className="muted small">Start</div>
          <div className="row gap"><button className="btn xs" onClick={() => nudge('start', -1)}>-1s</button><button className="btn xs" onClick={() => nudge('start', -0.25)}>-¼</button>
            <input type="number" step="0.1" value={start} onChange={(e) => setStart(Number(e.target.value))} />
            <button className="btn xs" onClick={() => nudge('start', 0.25)}>+¼</button><button className="btn xs" onClick={() => nudge('start', 1)}>+1s</button></div>
          <div className="muted small">{fmtTime(start)} in stream</div>
        </div>
        <div>
          <div className="muted small">End</div>
          <div className="row gap"><button className="btn xs" onClick={() => nudge('end', -1)}>-1s</button><button className="btn xs" onClick={() => nudge('end', -0.25)}>-¼</button>
            <input type="number" step="0.1" value={end} onChange={(e) => setEnd(Number(e.target.value))} />
            <button className="btn xs" onClick={() => nudge('end', 0.25)}>+¼</button><button className="btn xs" onClick={() => nudge('end', 1)}>+1s</button></div>
          <div className="muted small">{fmtTime(end)} in stream</div>
        </div>
        <div className={`len ${len < 10 || len > 60 ? 'warn' : ''}`}>{len.toFixed(1)}s<div className="muted small">Shorts: 10–60s</div></div>
      </div>
      <div className="grid3">
        <label>Framing
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="smart">Smart crop (track action)</option>
            <option value="blur">Fit + blurred background</option>
            <option value="center">Center crop</option>
            <option value="split">Facecam + gameplay</option>
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} /> Animated captions</label>
        <label className="check"><input type="checkbox" checked={deadAir} onChange={(e) => setDeadAir(e.target.checked)} /> Remove dead air</label>
        {brand('intro')?.exists && <label className="check"><input type="checkbox" checked={introOn} onChange={(e) => setIntro(e.target.checked)} /> Intro ({brand('intro')!.duration?.toFixed(1)}s)</label>}
        {brand('outro')?.exists && <label className="check"><input type="checkbox" checked={outroOn} onChange={(e) => setOutro(e.target.checked)} /> Outro ({brand('outro')!.duration?.toFixed(1)}s)</label>}
        {branding && !brand('intro')?.exists && !brand('outro')?.exists && <span className="muted small">Add an intro/outro in <a href="#/settings">Settings → Intro & outro</a></span>}
      </div>
      <div className="row end gap">
        {changed && <button className="btn sm ghost" onClick={() => { setStart(clip.start_sec); setEnd(clip.end_sec); setMode(clip.options?.reframeMode || 'smart'); setCaptions(clip.options?.captions ?? true); setDeadAir(clip.options?.deadAir ?? true); setIntro(null); setOutro(null); }}>Reset</button>}
        <button className="btn sm primary" disabled={busy || clip.status === 'published'} onClick={() => run(async () => {
          await api.post(`/api/clips/${clip.id}/regenerate`, { startSec: start, endSec: end, reframeMode: mode, captions, deadAir, intro: introOn, outro: outroOn });
          setIntro(null);
          setOutro(null);
          onQueued();
        }, 'Re-rendering — the clip will need approval again')}>↻ {changed ? 'Apply & re-render' : 'Regenerate'}</button>
      </div>
    </section>
  );
}

function CaptionPanel({ clip, onQueued }: { clip: ClipDetail; onQueued: () => void }) {
  // what's actually burned in: AI-cleaned captions unless the user edited them by hand
  const original = (!clip.captions?.edited && clip.options?.smartCaptions !== false && clip.edit_plan?.captions?.length ? clip.edit_plan.captions : clip.captions?.segments) || [];
  const [segs, setSegs] = useState<Segment[]>(original);
  const [open, setOpen] = useState(false);
  const { busy, run } = useAction();
  useEffect(() => setSegs(clip.captions?.segments || []), [clip.id, clip.version]);
  const dirty = JSON.stringify(segs.map((s) => s.text)) !== JSON.stringify(original.map((s) => s.text));
  return (
    <section className="card">
      <div className="card-head">
        <h3>Subtitles <span className="muted small">({original.length} lines{clip.captions?.edited ? ', edited by you' : clip.edit_plan?.captions ? ', cleaned by AI' : ''})</span></h3>
        <button className="btn sm ghost" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Edit subtitles'}</button>
      </div>
      {open && (
        <>
          {segs.length === 0 && <p className="muted small">No speech was transcribed for this range.</p>}
          <div className="caption-list">
            {segs.map((s, i) => (
              <div key={i} className="caption-row">
                <span className="muted small mono">{(s.start - clip.start_sec).toFixed(1)}s</span>
                <input value={s.text} onChange={(e) => setSegs(segs.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
                <button className="icon-btn" title="Remove line" onClick={() => setSegs(segs.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
          </div>
          <div className="row end gap">
            <button className="btn sm ghost" disabled={busy} onClick={() => run(async () => { await api.post(`/api/clips/${clip.id}/regenerate`, { refreshCaptions: true }); onQueued(); }, 'Captions reset from transcript')}>Reset from transcript</button>
            <button className="btn sm primary" disabled={!dirty && segs.length === original.length || busy} onClick={() => run(async () => {
              await api.post(`/api/clips/${clip.id}/regenerate`, { captionSegments: segs.map((s) => ({ start: s.start, end: s.end, text: s.text })) });
              toast('Saving subtitles & re-rendering');
              onQueued();
            })}>Save & re-render</button>
          </div>
        </>
      )}
    </section>
  );
}
