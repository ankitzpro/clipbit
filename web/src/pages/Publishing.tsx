import { api, clipThumbUrl, type Publication } from '../api';
import { useAction, usePoll } from '../hooks';
import { Badge, Empty, PageHead, Progress, fmtNum, timeAgo } from '../ui';

export function Publishing() {
  const { data, reload } = usePoll<Publication[]>('/api/publications', 3000);
  const { run } = useAction();
  const act = (fn: () => Promise<any>, msg: string) => run(async () => { await fn(); await reload(); }, msg);

  return (
    <>
      <PageHead title="Publishing History" sub="Every upload to your channel, with live progress and retry for failures." />
      {!data ? null : data.length === 0 ? (
        <Empty icon="🚀" title="Nothing published yet">Approve a clip, then hit Publish in the Approval Queue or Clip Studio.</Empty>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr><th></th><th>Title</th><th>Status</th><th>Visibility</th><th>Views</th><th>Likes</th><th>Queued</th><th></th></tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id}>
                  <td>{p.has_thumb && <a href={`#/studio/${p.clip_id}`}><img className="tiny-thumb" src={clipThumbUrl({ id: p.clip_id })} alt="" /></a>}</td>
                  <td>
                    <div className="ellipsis" style={{ maxWidth: 340 }}><b>{p.title}</b></div>
                    <div className="muted small">{p.stream_name}{p.youtube_video_id && <> · <a href={`https://youtube.com/shorts/${p.youtube_video_id}`} target="_blank" rel="noreferrer">open on YouTube ↗</a></>}</div>
                    {p.error && <div className="small warn">{p.error}</div>}
                  </td>
                  <td style={{ minWidth: 130 }}>
                    <Badge status={p.status} />
                    {p.status === 'uploading' && <Progress value={p.progress} />}
                    {p.status === 'scheduled' && p.publish_at && <div className="muted small">goes live {new Date(p.publish_at).toLocaleString()}</div>}
                  </td>
                  <td>{p.status === 'scheduled' ? 'scheduled' : p.privacy}</td>
                  <td>{fmtNum(p.stats?.views)}</td>
                  <td>{fmtNum(p.stats?.likes)}</td>
                  <td className="muted small">{timeAgo(p.created_at)}{p.attempts > 1 && ` · ${p.attempts} tries`}</td>
                  <td>
                    {p.status === 'failed' && (
                      <div className="row gap">
                        <button className="btn sm" onClick={() => act(() => api.post(`/api/publications/${p.id}/retry`), 'Retrying upload')}>↻ Retry</button>
                        <button className="btn sm ghost" onClick={() => act(() => api.del(`/api/publications/${p.id}`), 'Removed')}>Remove</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
