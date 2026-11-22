import { useState } from 'react';
import { api, type Moment, type Stream } from '../api';
import { navigate, useAction, usePoll } from '../hooks';
import { Badge, Empty, PageHead, Score, ScoreWhy, Stars, fmtTime, timeAgo } from '../ui';

const CATS = ['funny', 'action', 'unexpected', 'reaction', 'commentary', 'fail', 'win', 'close_call', 'other'];

export function Moments({ query }: { query: URLSearchParams }) {
  const [streamId, setStreamId] = useState(query.get('streamId') || '');
  const [minScore, setMinScore] = useState(0);
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState('recent');
  const qs = new URLSearchParams({ limit: '100', sort, ...(streamId && { streamId }), ...(minScore && { minScore: String(minScore) }), ...(category && { category }), ...(status && { status }) });
  const { data, reload } = usePoll<{ items: Moment[]; total: number }>(`/api/moments?${qs}`, 6000);
  const { data: streams } = usePoll<Stream[]>('/api/streams', 0);
  const [open, setOpen] = useState<string | null>(null);
  const { run } = useAction();

  // your own ★ rating teaches the scorer what you like (categories you rate high/low get nudged, best/worst go to the AI)
  const rate = (m: Moment, stars: number | null) =>
    run(async () => { await api.post(`/api/moments/${m.id}/rating`, { stars }); await reload(); }, stars ? `Rated ${stars}★` : 'Rating cleared');

  const makeClip = (m: Moment) =>
    run(async () => {
      const r = await api.post<{ clipId: string }>(`/api/moments/${m.id}/clip`);
      navigate(`/studio/${r.clipId}`);
    }, 'Clip queued for rendering');

  return (
    <>
      <PageHead title="Detected Moments" sub={`${data?.total ?? 0} moments flagged by AI. High scorers are clipped automatically (see Settings).`} />
      <div className="filters">
        <select value={streamId} onChange={(e) => setStreamId(e.target.value)}>
          <option value="">All streams</option>
          {streams?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {CATS.map((c) => <option key={c}>{c}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option>
          <option value="new">Not clipped</option>
          <option value="clipped">Clipped</option>
          <option value="dismissed">Dismissed</option>
        </select>
        <label className="inline">Min score {minScore}<input type="range" min={0} max={95} step={5} value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} /></label>
        <select value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="recent">Newest first</option>
          <option value="score">Highest score</option>
        </select>
      </div>
      {!data ? null : data.items.length === 0 ? (
        <Empty icon="⚡" title="Nothing here yet">Moments appear a minute or two after a stream starts being analysed.</Empty>
      ) : (
        <div className="moment-list">
          {data.items.map((m) => (
            <div key={m.id} className={`card moment ${m.status === 'dismissed' ? 'dim' : ''}`}>
              <div className="row gap top">
                <Score value={m.score} breakdown={m.score_breakdown ?? null} />
                <div className="grow">
                  <div className="row gap wrap">
                    <b className="moment-title">{m.title}</b>
                    {m.category && <span className="chip">{m.category}</span>}
                    {(m as any).mission && <a className="chip" href="#/missions">🎯 {(m as any).mission}</a>}
                    <span className="chip ghost" title="Detector">{m.detector === 'heuristic' ? 'signals' : m.detector === 'ollama' ? 'AI · local' : 'AI · Gemini'}</span>
                  </div>
                  <div className="muted small">
                    {m.stream_name} · {fmtTime(m.start_sec)}–{fmtTime(m.end_sec)} ({Math.round(m.end_sec - m.start_sec)}s) · {timeAgo(m.created_at)}
                  </div>
                  {m.description && <p className="desc">{m.description}</p>}
                  <div className="row gap wrap" style={{ marginTop: 4 }}>
                    <Stars value={m.user_rating} onChange={(st) => rate(m, st)} />
                    <ScoreWhy breakdown={m.score_breakdown ?? null} />
                  </div>
                  {open === m.id && (
                    <div className="transcript">
                      {m.transcript ? `“${m.transcript}”` : <span className="muted">No speech in this moment.</span>}
                      <div className="tags">{m.hashtags.map((h) => <span key={h} className="tag">{h}</span>)}</div>
                    </div>
                  )}
                </div>
                <div className="col gap end-align">
                  {m.clip_id ? (
                    <a className="btn sm" href={`#/studio/${m.clip_id}`}>Open clip <Badge status={m.clip_status || ''} /></a>
                  ) : (
                    <button className="btn sm primary" onClick={() => makeClip(m)}>Generate clip</button>
                  )}
                  <div className="row gap">
                    <button className="btn sm ghost" onClick={() => setOpen(open === m.id ? null : m.id)}>{open === m.id ? 'Less' : 'Details'}</button>
                    {m.status === 'new' && <button className="btn sm ghost" onClick={() => run(async () => { await api.post(`/api/moments/${m.id}/dismiss`); await reload(); })}>Dismiss</button>}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
