import { useState } from 'react';
import { api, clipThumbUrl, clipVideoUrl, type ClipSummary } from '../api';
import { navigate, useAction, usePoll } from '../hooks';
import { Badge, Empty, Modal, PageHead, PublishDialog, Score, ScoreWhy, Stars, fmtDur, timeAgo } from '../ui';
import { ClipCard } from './Studio';

export function Approval() {
  const [tab, setTab] = useState<'review' | 'approved'>('review');
  const { data, reload } = usePoll<ClipSummary[]>(`/api/clips?status=${tab === 'review' ? 'ready' : 'approved'}`, 5000);
  const [preview, setPreview] = useState<ClipSummary | null>(null);
  const [publish, setPublish] = useState<ClipSummary | null>(null);
  const { run } = useAction();
  const act = (fn: () => Promise<any>, msg: string) => run(async () => { await fn(); await reload(); }, msg);
  // ★ rating while reviewing — teaches the scorer your taste
  const rate = (c: ClipSummary, stars: number | null) =>
    run(async () => { await api.post(`/api/clips/${c.id}/rating`, { stars }); setPreview((p) => (p && p.id === c.id ? { ...p, user_rating: stars } : p)); await reload(); }, stars ? `Rated ${stars}★` : 'Rating cleared');
  const reject = (c: ClipSummary) => {
    const reason = prompt('Why reject? (optional — teaches the AI your taste)');
    if (reason !== null) void act(() => api.post(`/api/clips/${c.id}/reject`, { reason }), 'Rejected');
  };

  return (
    <>
      <PageHead title="Approval Queue" sub="Nothing is ever published without your explicit approval." />
      <div className="tabs">
        <button className={tab === 'review' ? 'on' : ''} onClick={() => setTab('review')}>Needs review</button>
        <button className={tab === 'approved' ? 'on' : ''} onClick={() => setTab('approved')}>Approved — ready to publish</button>
      </div>
      {!data ? null : data.length === 0 ? (
        <Empty icon={tab === 'review' ? '🎉' : '📭'} title={tab === 'review' ? 'All caught up' : 'No approved clips waiting'}>
          {tab === 'review' ? 'New clips will show up here as soon as they finish rendering.' : 'Approve clips in the review tab, then publish them from here.'}
        </Empty>
      ) : (
        <div className="clip-grid">
          {data.map((c) => (
            <ClipCard key={c.id} c={c} onClick={() => setPreview(c)}>
              {c.description && <p className="small muted ellipsis2">{c.description}</p>}
              <div className="tags">{c.hashtags.slice(0, 4).map((h) => <span key={h} className="tag">{h}</span>)}</div>
              <div className="row gap wrap">
                {tab === 'review' ? (
                  <>
                    <button className="btn sm primary" onClick={() => act(() => api.post(`/api/clips/${c.id}/approve`), 'Approved')}>✓ Approve</button>
                    <button className="btn sm ghost danger" onClick={() => reject(c)}>✕ Reject</button>
                  </>
                ) : (
                  <>
                    {c.publication && ['queued', 'uploading'].includes(c.publication.status || '') ? (
                      <Badge status={c.publication.status!}>{c.publication.status} {c.publication.progress}%</Badge>
                    ) : (
                      <button className="btn sm primary" onClick={() => setPublish(c)}>🚀 Publish</button>
                    )}
                    <button className="btn sm ghost" onClick={() => act(() => api.post(`/api/clips/${c.id}/unapprove`), 'Moved back to review')}>Undo</button>
                  </>
                )}
                <button className="btn sm ghost" onClick={() => navigate(`/studio/${c.id}`)}>Edit</button>
                <a className="btn sm ghost" href={`/api/clips/${c.id}/download`}>⬇</a>
              </div>
            </ClipCard>
          ))}
        </div>
      )}

      {preview && (
        <Modal title={preview.title} onClose={() => setPreview(null)} wide>
          <div className="preview-modal">
            <div className="phone"><video src={clipVideoUrl(preview)} poster={clipThumbUrl(preview)} controls autoPlay playsInline loop /></div>
            <div className="col gap">
              <div className="row gap"><Score value={preview.score} breakdown={preview.score_breakdown ?? null} /><Badge status={preview.status} /><span className="muted small">{fmtDur(preview.duration)} · {preview.stream_name} · {timeAgo(preview.created_at)}</span></div>
              <div className="row gap wrap"><span className="small muted">Your rating</span><Stars value={preview.user_rating} onChange={(st) => rate(preview, st)} size={22} /></div>
              <ScoreWhy breakdown={preview.score_breakdown ?? null} />
              <p>{preview.description}</p>
              <div className="tags">{preview.hashtags.map((h) => <span key={h} className="tag">{h}</span>)}</div>
              <div className="row gap wrap">
                {preview.status === 'ready' && <button className="btn primary" onClick={() => { void act(() => api.post(`/api/clips/${preview.id}/approve`), 'Approved'); setPreview(null); }}>✓ Approve</button>}
                {preview.status === 'ready' && <button className="btn ghost danger" onClick={() => { reject(preview); setPreview(null); }}>✕ Reject</button>}
                <button className="btn ghost" onClick={() => navigate(`/studio/${preview.id}`)}>Open in Studio</button>
              </div>
            </div>
          </div>
        </Modal>
      )}
      {publish && <PublishDialog clip={publish} onClose={() => setPublish(null)} onDone={reload} />}
    </>
  );
}
