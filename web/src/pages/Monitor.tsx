import { useState } from 'react';
import { api, type Stream } from '../api';
import { useAction, usePoll, toast } from '../hooks';
import { Badge, Empty, Modal, PageHead, Progress, fmtTime, timeAgo } from '../ui';

const KIND_LABEL: Record<string, string> = { live: 'Live video', channel: 'Channel (auto-detect live)', vod: 'Past broadcast / video', file: 'Uploaded file' };

export function Monitor() {
  const { data: streams, reload } = usePoll<Stream[]>('/api/streams', 4000);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Stream | null>(null);
  const [recordingsOf, setRecordingsOf] = useState<Stream | null>(null);
  const { run } = useAction();

  const act = (fn: () => Promise<any>, msg: string) => run(async () => { await fn(); await reload(); }, msg);

  return (
    <>
      <PageHead
        title="Live Monitor"
        sub="Streams are recorded in chunks and analysed continuously — no need to watch them yourself."
        actions={<button className="btn primary" onClick={() => setAdding(true)}>+ Add stream</button>}
      />
      {!streams ? null : streams.length === 0 ? (
        <Empty icon="📡" title="No streams yet">Add a YouTube live URL, a channel URL (we'll catch it whenever it goes live), a past broadcast, or upload your own recording.</Empty>
      ) : (
        <div className="stream-grid">
          {streams.map((s) => {
            const st = s.paused ? 'paused' : s.status;
            const live = st === 'live';
            return (
              <div key={s.id} className={`card stream ${live ? 'is-live' : ''}`}>
                <div className="row gap">
                  <div className="grow">
                    <div className="row gap"><Badge status={st} /><span className="muted small">{KIND_LABEL[s.kind]}</span></div>
                    <h3 className="ellipsis" title={s.name}>{s.name}</h3>
                    {s.source_title && s.source_title !== s.name && <div className="muted small ellipsis">{s.source_title}</div>}
                  </div>
                </div>
                {s.url && <a className="small ellipsis block" href={s.url} target="_blank" rel="noreferrer">{s.url}</a>}
                <div className="stats3">
                  <div><b>{fmtTime(s.recorded_seconds)}</b><span>recorded</span></div>
                  <div><b>{s.moment_count}</b><span>moments</span></div>
                  <div><b>{s.clip_count}</b><span>clips</span></div>
                </div>
                {s.pending_chunks > 0 && (
                  <div className="small muted">
                    Analysing {s.pending_chunks} chunk{s.pending_chunks > 1 ? 's' : ''}…
                    <Progress value={s.chunk_count ? ((s.chunk_count - s.pending_chunks) / s.chunk_count) * 100 : 5} />
                  </div>
                )}
                {live && s.live_since && <div className="small muted">Recording since {timeAgo(s.live_since)}</div>}
                {s.options?.saveFullRecording && <div className="small muted">🎞 Full recordings are saved as video files</div>}
                {!live && s.last_checked_at && (s.kind === 'live' || s.kind === 'channel') && <div className="small muted">Last checked {timeAgo(s.last_checked_at)}</div>}
                {s.last_error && <div className="small warn">{s.last_error}</div>}
                <div className="row gap wrap actions">
                  {(s.kind === 'live' || s.kind === 'channel') &&
                    (s.paused ? (
                      <button className="btn sm" onClick={() => act(() => api.patch(`/api/streams/${s.id}`, { paused: false }), 'Resumed')}>▶ Resume</button>
                    ) : (
                      <button className="btn sm" onClick={() => act(() => api.patch(`/api/streams/${s.id}`, { paused: true }), 'Paused')}>⏸ Pause</button>
                    ))}
                  {(s.status === 'error' || s.status === 'offline') && <button className="btn sm" onClick={() => act(() => api.post(`/api/streams/${s.id}/retry`), 'Retrying')}>↻ Retry now</button>}
                  <a className="btn sm ghost" href={`#/moments?streamId=${s.id}`}>Moments</a>
                  {s.chunk_count > 0 && (
                    <button
                      className="btn sm ghost"
                      title="Delete un-reviewed moments and clips and run the AI over the recorded footage again"
                      onClick={() => confirm('Re-analyse this stream? Un-reviewed moments and clips are replaced; approved and published clips are kept.') && act(() => api.post(`/api/streams/${s.id}/reanalyze`), 'Re-analysing with AI…')}
                    >✨ Re-analyse</button>
                  )}
                  <button className="btn sm ghost" onClick={() => setRecordingsOf(s)}>🎞 Recordings</button>
                  <button className="btn sm ghost" onClick={() => setEditing(s)}>Options</button>
                  <button
                    className="btn sm ghost danger"
                    onClick={() => confirm(`Remove "${s.name}"? Raw recordings and saved full-recording videos are deleted; rendered clips are kept.`) && act(() => api.del(`/api/streams/${s.id}`), 'Stream removed')}
                  >Remove</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {adding && <AddStream onClose={() => setAdding(false)} onDone={reload} />}
      {editing && <StreamOptions stream={editing} onClose={() => setEditing(null)} onDone={reload} />}
      {recordingsOf && <Recordings stream={recordingsOf} onClose={() => setRecordingsOf(null)} />}
    </>
  );
}

interface SessionRec {
  id: string; title: string | null; active: boolean; started_at: string; ended_at: string | null;
  recording_status: 'queued' | 'saving' | 'ready' | 'failed' | null; recording_bytes: number | null; recording_duration: number | null;
  recording_error: string | null; chunk_count: number; chunks_available: number; recorded_seconds: number;
}

const fmtSize = (b: number | null) => (!b ? '' : b >= 1073741824 ? `${(b / 1073741824).toFixed(2)} GB` : `${Math.round(b / 1048576)} MB`);

/** Every recording session of a stream, with its saved full-length video (download / save / delete). */
function Recordings({ stream, onClose }: { stream: Stream; onClose: () => void }) {
  const { data, reload } = usePoll<SessionRec[]>(`/api/streams/${stream.id}/recordings`, 3000);
  const { busy, run } = useAction();
  const act = (fn: () => Promise<any>, msg: string) => run(async () => { await fn(); await reload(); }, msg);
  return (
    <Modal title={`Recordings — ${stream.name}`} onClose={onClose}>
      <p className="muted small" style={{ marginTop: 0 }}>
        Each time the stream is recorded you get one entry. Saved videos are full-length MP4s on your D: drive and are never deleted automatically.
        {!stream.options?.saveFullRecording && stream.kind !== 'file' && ' Turn on “Save each full recording” in Options to save new ones automatically.'}
      </p>
      {!data ? null : data.length === 0 ? (
        <p className="muted">Nothing recorded yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Recorded</th><th>Length</th><th>Video file</th></tr></thead>
            <tbody>
              {data.map((r) => {
                const canSave = !r.active && r.chunks_available > 0 && (r.recording_status === null || r.recording_status === 'failed');
                return (
                  <tr key={r.id}>
                    <td>
                      <div>{new Date(r.started_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</div>
                      {r.title && <div className="muted small ellipsis" style={{ maxWidth: 200 }}>{r.title}</div>}
                    </td>
                    <td>{fmtTime(r.recording_duration ?? r.recorded_seconds)}</td>
                    <td className="small">
                      {r.active ? <Badge status="live" />
                        : r.recording_status === 'ready' ? <span>✅ {fmtSize(r.recording_bytes)}</span>
                        : r.recording_status === 'queued' || r.recording_status === 'saving' ? <span>⏳ {r.recording_status === 'saving' ? 'Joining pieces…' : 'Queued…'}</span>
                        : r.recording_status === 'failed' ? <span className="warn">Failed</span>
                        : r.chunks_available > 0 ? <span className="muted">Not saved</span>
                        : <span className="muted">Raw pieces deleted</span>}
                      {r.recording_error && <div className={r.recording_status === 'failed' ? 'warn' : 'muted'}>{r.recording_error}</div>}
                      <div className="row gap wrap" style={{ marginTop: 6 }}>
                        {r.recording_status === 'ready' && (
                          <>
                            <a className="btn sm primary" href={`/api/sessions/${r.id}/recording.mp4`} download>⬇ Download</a>
                            <button
                              className="btn sm ghost danger"
                              disabled={busy}
                              onClick={() => confirm('Delete this saved video from your disk? Moments and clips from this recording stay.') && act(() => api.del(`/api/sessions/${r.id}/recording`), 'Saved video deleted')}
                            >Delete video</button>
                          </>
                        )}
                        {canSave && (
                          <button className="btn sm" disabled={busy} onClick={() => act(() => api.post(`/api/sessions/${r.id}/save-recording`), 'Saving as one video…')}>
                            {r.recording_status === 'failed' ? '↻ Retry save' : '💾 Save as video'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

function AddStream({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [tab, setTab] = useState<'url' | 'file'>('url');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState('auto');
  const [perm, setPerm] = useState(false);
  const [saveFull, setSaveFull] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const { busy, run } = useAction();

  const submit = () =>
    run(async () => {
      if (tab === 'url') await api.post('/api/streams', { url, name, kind, permissionConfirmed: perm, options: saveFull ? { saveFullRecording: true } : {} });
      else if (file) await api.upload(file, name || file.name, setPct);
      toast('Stream added — monitoring started');
      onDone();
      onClose();
    });

  return (
    <Modal title="Add a stream" onClose={onClose}>
      <div className="tabs">
        <button className={tab === 'url' ? 'on' : ''} onClick={() => setTab('url')}>YouTube URL</button>
        <button className={tab === 'file' ? 'on' : ''} onClick={() => setTab('file')}>Upload recording</button>
      </div>
      <div className="form">
        {tab === 'url' ? (
          <>
            <label>YouTube URL<input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.youtube.com/watch?v=…  or  https://www.youtube.com/@yourchannel" /></label>
            <label>Type
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="auto">Auto-detect</option>
                <option value="live">Live stream (record while live)</option>
                <option value="channel">Channel (watch for new live streams)</option>
                <option value="vod">Past broadcast / video (process once)</option>
              </select>
            </label>
          </>
        ) : (
          <label>Video file (mp4, mkv, mov, webm…)<input type="file" accept="video/*,.mkv,.ts,.flv" onChange={(e) => setFile(e.target.files?.[0] || null)} /></label>
        )}
        <label>Display name (optional)<input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. My GTA 6 streams" /></label>
        {tab === 'url' && (
          <label className="check">
            <input type="checkbox" checked={saveFull} onChange={(e) => setSaveFull(e.target.checked)} />
            <span>🎞 Also save the full recording as one video file
              <span className="muted small block">When the stream ends, it’s kept on your D: drive (never auto-deleted) and can be downloaded from Live Monitor → Recordings. Roughly 2–4 GB per hour at 1080p. Moments are still found as usual.</span>
            </span>
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={perm} onChange={(e) => setPerm(e.target.checked)} />
          I own this stream/recording or have the creator's explicit permission to clip and republish it.
        </label>
        {pct !== null && <Progress value={pct} />}
        <div className="row end gap">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!perm || busy || (tab === 'url' ? !url.trim() : !file)} onClick={submit}>{busy ? (pct !== null ? `Uploading ${pct}%` : 'Checking…') : 'Start monitoring'}</button>
        </div>
      </div>
    </Modal>
  );
}

function StreamOptions({ stream, onClose, onDone }: { stream: Stream; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(stream.name);
  const [mode, setMode] = useState(stream.options?.reframeMode || '');
  const fc = stream.options?.facecam || { x: 0.72, y: 0.04, w: 0.26, h: 0.3 };
  const [cam, setCam] = useState(fc);
  const [saveFull, setSaveFull] = useState(!!stream.options?.saveFullRecording);
  const { busy, run } = useAction();
  const save = () =>
    run(async () => {
      await api.patch(`/api/streams/${stream.id}`, {
        name,
        options: { reframeMode: mode || null, facecam: mode === 'split' ? cam : stream.options?.facecam || null, saveFullRecording: saveFull },
      });
      onDone();
      onClose();
    }, 'Saved');
  return (
    <Modal title="Stream options" onClose={onClose}>
      <div className="form">
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        {stream.kind !== 'file' && (
          <label className="check">
            <input type="checkbox" checked={saveFull} onChange={(e) => setSaveFull(e.target.checked)} />
            <span>🎞 Save each full recording as one video file
              <span className="muted small block">Applies to recordings that end from now on. For earlier ones use “Save as video” in Recordings.</span>
            </span>
          </label>
        )}
        <label>Vertical framing for this stream
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="">Use global setting</option>
            <option value="smart">Smart crop (follow the action)</option>
            <option value="blur">Fit with blurred background</option>
            <option value="center">Center crop</option>
            <option value="split">Facecam on top + gameplay</option>
          </select>
        </label>
        {mode === 'split' && (
          <>
            <p className="muted small">Facecam position as a fraction of the 16:9 frame (0–1). Default is the top-right corner.</p>
            <div className="grid4">
              {(['x', 'y', 'w', 'h'] as const).map((k) => (
                <label key={k}>{k}<input type="number" step="0.01" min="0" max="1" value={cam[k]} onChange={(e) => setCam({ ...cam, [k]: Number(e.target.value) })} /></label>
              ))}
            </div>
            <div className="cam-preview"><div style={{ left: `${cam.x * 100}%`, top: `${cam.y * 100}%`, width: `${cam.w * 100}%`, height: `${cam.h * 100}%` }} /></div>
          </>
        )}
        <div className="row end gap">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={save}>Save</button>
        </div>
      </div>
    </Modal>
  );
}
