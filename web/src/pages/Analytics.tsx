import { api } from '../api';
import { useAction, usePoll } from '../hooks';
import { Empty, PageHead, fmtDur, fmtNum, timeAgo } from '../ui';

export function Analytics() {
  const { data, reload } = usePoll<any>('/api/analytics', 30000);
  const { busy, run } = useAction();
  if (!data) return <PageHead title="Analytics" sub="Loading…" />;
  const f = data.funnel || {};
  const L = data.learning;
  const maxViews = Math.max(1, ...data.published.map((p: any) => Number(p.stats?.views || 0)));
  const funnel = [
    ['Moments detected', f.moments],
    ['Clips generated', f.clips],
    ['Approved by you', f.approved],
    ['Published', f.published],
  ] as const;

  return (
    <>
      <PageHead
        title="Analytics"
        sub="How your Shorts perform — and what the AI has learned from your choices."
        actions={<button className="btn ghost" disabled={busy} onClick={() => run(async () => { await api.post('/api/analytics/refresh'); setTimeout(reload, 5000); }, 'Refreshing stats from YouTube…')}>↻ Refresh from YouTube</button>}
      />
      <div className="tiles">
        <div className="tile"><div className="muted small">Total views</div><div className="tile-value">{fmtNum(data.totals.views)}</div></div>
        <div className="tile"><div className="muted small">Likes</div><div className="tile-value">{fmtNum(data.totals.likes)}</div></div>
        <div className="tile"><div className="muted small">Comments</div><div className="tile-value">{fmtNum(data.totals.comments)}</div></div>
        <div className="tile"><div className="muted small">Engagement</div><div className="tile-value">{data.totals.views ? (((data.totals.likes + data.totals.comments) / data.totals.views) * 100).toFixed(1) + '%' : '–'}</div></div>
      </div>

      <div className="grid-2col">
        <section className="card">
          <h2>Pipeline funnel</h2>
          {funnel.map(([label, n]) => (
            <div key={label} className="bar-row">
              <span>{label}</span>
              <div className="bar"><div style={{ width: `${f.moments ? Math.max(2, ((n || 0) / f.moments) * 100) : 0}%` }} /></div>
              <b>{n ?? 0}</b>
            </div>
          ))}
        </section>
        <section className="card">
          <h2>What the AI has learned</h2>
          {!L || L.totalReviewed === 0 ? (
            <p className="muted">Approve or reject a few clips — the detector adapts to your taste and to what performs on your channel.</p>
          ) : (
            <>
              <p className="muted small">Based on {L.totalReviewed} reviewed clips{L.topPerformers.length ? ` and ${L.topPerformers.length} published Shorts` : ''}.</p>
              {Object.entries(L.categoryApproval).sort((a: any, b: any) => b[1].rate - a[1].rate).map(([cat, v]: [string, any]) => (
                <div key={cat} className="bar-row">
                  <span>{cat}</span>
                  <div className="bar"><div style={{ width: `${Math.max(2, v.rate * 100)}%` }} /></div>
                  <b>{Math.round(v.rate * 100)}%</b>
                </div>
              ))}
              <div className="muted small">approval rate by category</div>
            </>
          )}
        </section>
      </div>

      <section className="card">
        <h2>Performance by category</h2>
        {data.byCategory.length === 0 ? <p className="muted">No clips yet.</p> : (
          <table className="table">
            <thead><tr><th>Category</th><th>Clips</th><th>Approved</th><th>Rejected</th><th>Published</th><th>Avg views</th><th>Avg retention</th></tr></thead>
            <tbody>
              {data.byCategory.map((c: any) => (
                <tr key={c.category}><td>{c.category}</td><td>{c.clips}</td><td>{c.approved}</td><td>{c.rejected}</td><td>{c.published}</td><td>{fmtNum(Math.round(c.avg_views))}</td><td>{c.avg_retention ? `${c.avg_retention.toFixed(0)}%` : '–'}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Published Shorts</h2>
        {data.published.length === 0 ? (
          <Empty icon="📈" title="No published Shorts yet">Stats are pulled from the YouTube Data & Analytics APIs every 6 hours.</Empty>
        ) : (
          <table className="table">
            <thead><tr><th>Title</th><th>Views</th><th>Likes</th><th>Comments</th><th>Avg viewed</th><th>Engagement</th><th>Length</th><th>Updated</th></tr></thead>
            <tbody>
              {data.published.map((p: any) => (
                <tr key={p.id}>
                  <td>
                    <a href={`https://youtube.com/shorts/${p.youtube_video_id}`} target="_blank" rel="noreferrer">{p.title}</a>
                    <div className="bar thin"><div style={{ width: `${(Number(p.stats?.views || 0) / maxViews) * 100}%` }} /></div>
                  </td>
                  <td>{fmtNum(p.stats?.views)}</td>
                  <td>{fmtNum(p.stats?.likes)}</td>
                  <td>{fmtNum(p.stats?.comments)}</td>
                  <td>{p.stats?.avgViewPercentage != null ? `${Math.round(p.stats.avgViewPercentage)}%` : '–'}</td>
                  <td>{p.stats?.engagementRate != null ? `${p.stats.engagementRate}%` : '–'}</td>
                  <td>{fmtDur(p.duration)}</td>
                  <td className="muted small">{timeAgo(p.stats_updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
