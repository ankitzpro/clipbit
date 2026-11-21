import { clipThumbUrl } from '../api';
import { usePoll } from '../hooks';
import { Badge, Empty, PageHead, Score, fmtDur, fmtNum, timeAgo } from '../ui';

export function Dashboard() {
  const { data: d } = usePoll<any>('/api/dashboard', 5000);
  const { data: sys } = usePoll<any>('/api/system', 30000);
  if (!d) return <PageHead title="Dashboard" sub="Loading…" />;

  const totalStreams = Object.values(d.streams || {}).reduce((a: number, b: any) => a + b, 0) as number;
  const tiles = [
    { label: 'Streams monitored', value: totalStreams, sub: `${d.streams.live || 0} live now`, href: '#/monitor' },
    { label: 'Moments detected', value: d.moments?.total ?? 0, sub: `${d.moments?.today ?? 0} in the last 24h · avg score ${d.moments?.avg_score ?? 0}`, href: '#/moments' },
    { label: 'Awaiting review', value: d.clips.ready || 0, sub: `${(d.clips.rendering || 0) + (d.clips.queued || 0)} rendering`, href: '#/approval' },
    { label: 'Shorts published', value: d.publications?.published ?? 0, sub: `${fmtNum(d.publications?.views)} total views`, href: '#/publishing' },
  ];

  const warnings: string[] = [];
  if (sys && !sys.gemini && !sys.ollama?.ready) warnings.push('No AI available: start Ollama with a vision model (ollama pull qwen2.5vl:3b) or add a GEMINI_API_KEY in .env.');
  if (sys?.aiProvider?.detect === 'ollama' && sys.ollama && !sys.ollama.ready) warnings.push(`Ollama isn't ready (${sys.ollama.error}). Moment finding falls back to Gemini.`);
  if (sys?.gemini && sys.geminiHealth && !sys.geminiHealth.ok) warnings.push(`Gemini AI is failing (${sys.geminiHealth.model}): ${sys.geminiHealth.error} — the other AI provider is used where possible. Check your key/billing or switch providers in Settings.`);
  if (sys && !sys.whisper) warnings.push(sys.whisperStatus?.loading ? 'Whisper is downloading/loading its speech model (first start can take several minutes). Captions start once it is ready.' : `Whisper speech-to-text is not ready${sys.whisperStatus?.error ? ` (${sys.whisperStatus.error})` : ''}. Clips render without captions until it is ready.`);
  if (sys && !sys.ytdlp) warnings.push('yt-dlp is not available in the container — live stream monitoring will not work.');
  if (sys && !sys.youtubeConfigured) warnings.push('YouTube upload is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET). You can still review and download clips.');

  return (
    <>
      <PageHead title="Dashboard" sub="Your AI clipping pipeline at a glance" actions={<a className="btn primary" href="#/monitor">+ Add stream</a>} />
      {warnings.map((w) => (
        <div key={w} className="notice">{w}</div>
      ))}
      <div className="tiles">
        {tiles.map((t) => (
          <a key={t.label} href={t.href} className="tile">
            <div className="muted small">{t.label}</div>
            <div className="tile-value">{t.value}</div>
            <div className="muted small">{t.sub}</div>
          </a>
        ))}
      </div>

      <div className="grid-2col">
        <section className="card">
          <div className="card-head"><h2>Latest moments</h2><a href="#/moments" className="small">View all →</a></div>
          {d.recentMoments.length === 0 ? (
            <Empty icon="⚡" title="No moments yet">Add a stream and the AI will start flagging highlights here.</Empty>
          ) : (
            <ul className="list">
              {d.recentMoments.map((m: any) => (
                <li key={m.id} className="row gap">
                  <Score value={m.score} size={38} />
                  <div className="grow">
                    <div className="ellipsis"><b>{m.title}</b></div>
                    <div className="muted small">{m.stream_name} · {m.category} · {timeAgo(m.created_at)}</div>
                  </div>
                  <Badge status={m.status} />
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card">
          <div className="card-head"><h2>Latest clips</h2><a href="#/approval" className="small">Review →</a></div>
          {d.recentClips.length === 0 ? (
            <Empty icon="🎬" title="No clips yet">Clips are rendered automatically for high-scoring moments.</Empty>
          ) : (
            <div className="thumb-row">
              {d.recentClips.map((c: any) => (
                <a key={c.id} href={`#/studio/${c.id}`} className="mini-clip">
                  <div className="mini-thumb">{c.has_thumb ? <img src={clipThumbUrl(c)} alt="" loading="lazy" /> : <span className="muted small">{c.status}</span>}</div>
                  <div className="small ellipsis2">{c.title}</div>
                  <div className="row gap small"><Badge status={c.status} /><span className="muted">{fmtDur(c.duration)}</span></div>
                </a>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="card">
        <div className="card-head"><h2>Background workers</h2></div>
        <div className="queue-grid">
          {Object.entries(d.queues || {}).map(([name, c]: [string, any]) => (
            <div key={name} className="queue">
              <b>{name}</b>
              <div className="muted small">{c.active || 0} active · {c.waiting || 0} waiting · {c.delayed || 0} delayed</div>
              <div className="muted small">{c.completed || 0} done · <span className={c.failed ? 'warn' : ''}>{c.failed || 0} failed</span></div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
