import { useEffect, useMemo, useState } from 'react';
import { api, type Stream } from '../api';
import { navigate, useAction, usePoll } from '../hooks';
import { Badge, Empty, PageHead, Score, fmtTime, timeAgo } from '../ui';

interface MissionMoment { id: string; title: string; score: number; category: string | null; start_sec: number; end_sec: number; description: string | null }
interface Mission {
  session_id: string; mission: string; stream_name: string; session_title: string | null; started_at: string;
  moment_count: number; start_sec: number; end_sec: number; best_score: number; moments: MissionMoment[];
  shorts: { id: string; status: string; title: string; duration: number | null }[] | null;
}

export function Missions() {
  const [streamId, setStreamId] = useState('');
  const { data: streams } = usePoll<Stream[]>('/api/streams', 0);
  const { data: settings } = usePoll<any>('/api/settings', 0);
  const { data, reload } = usePoll<Mission[]>(`/api/missions${streamId ? `?streamId=${streamId}` : ''}`, 8000);

  return (
    <>
      <PageHead title="Missions" sub="The AI groups moments by the mission they happened in. Pick the best ones and combine them into one mission Short." />
      <div className="filters">
        <select value={streamId} onChange={(e) => setStreamId(e.target.value)}>
          <option value="">All streams</option>
          {streams?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
      {!data ? null : data.length === 0 ? (
        <Empty icon="🎯" title="No missions detected yet">Missions are labelled by Gemini while it analyses the stream. Older moments (before this update) have no mission — use ✨ Re-analyse on the stream.</Empty>
      ) : (
        data.map((m) => <MissionCard key={m.session_id + m.mission} m={m} target={settings?.missionShort?.targetSeconds ?? 60} max={settings?.missionShort?.maxSeconds ?? 170} maxParts={settings?.missionShort?.maxParts ?? 6} onDone={reload} />)
      )}
    </>
  );
}

function MissionCard({ m, target, max, maxParts, onDone }: { m: Mission; target: number; max: number; maxParts: number; onDone: () => void }) {
  // pre-select the best moments that fit the target length, shown in story order
  const auto = useMemo(() => {
    const picked: string[] = [];
    let total = 0;
    for (const x of [...m.moments].sort((a, b) => b.score - a.score)) {
      const d = x.end_sec - x.start_sec;
      if (picked.length >= maxParts || (picked.length >= 2 && total + d > target)) continue;
      picked.push(x.id);
      total += d;
    }
    return picked;
  }, [m.moments, target, maxParts]);
  const [sel, setSel] = useState<string[]>(auto);
  useEffect(() => setSel(auto), [auto.join()]);
  const [open, setOpen] = useState(false);
  const { busy, run } = useAction();
  const chosen = m.moments.filter((x) => sel.includes(x.id));
  const seconds = chosen.reduce((a, x) => a + (x.end_sec - x.start_sec), 0);

  const create = () =>
    run(async () => {
      const r = await api.post<{ clipId: string }>('/api/missions/compile', { momentIds: sel });
      onDone();
      navigate(`/studio/${r.clipId}`);
    }, 'Rendering mission Short — the AI will watch it and write the title & hook');

  return (
    <section className="card">
      <div className="row gap top">
        <div className="mission-icon">🎯</div>
        <div className="grow">
          <h2 style={{ margin: 0 }}>{m.mission}</h2>
          <div className="muted small">{m.stream_name} · {fmtTime(m.start_sec)}–{fmtTime(m.end_sec)} in stream · {m.moment_count} moments · {timeAgo(m.started_at)}</div>
          {m.shorts?.length ? (
            <div className="row gap wrap mt">
              {m.shorts.map((s) => (
                <a key={s.id} className="chip" href={`#/studio/${s.id}`}>🎬 {s.title.slice(0, 40)} <Badge status={s.status} /></a>
              ))}
            </div>
          ) : null}
        </div>
        <Score value={m.best_score} />
        <button className="btn sm ghost" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Choose moments'}</button>
      </div>
      {open && (
        <div className="mission-moments">
          {m.moments.map((x, i) => (
            <label key={x.id} className={`mission-moment ${sel.includes(x.id) ? 'on' : ''}`}>
              <input type="checkbox" checked={sel.includes(x.id)} onChange={(e) => setSel(e.target.checked ? [...sel, x.id] : sel.filter((y) => y !== x.id))} />
              <span className="muted small mono">{i + 1}.</span>
              <span className="grow">
                <b>{x.title}</b>
                <span className="muted small"> · {fmtTime(x.start_sec)} · {Math.round(x.end_sec - x.start_sec)}s{x.category ? ` · ${x.category}` : ''}</span>
                {x.description && <div className="muted small ellipsis">{x.description}</div>}
              </span>
              <Score value={x.score} size={34} />
            </label>
          ))}
        </div>
      )}
      <div className="row gap end mt">
        <span className={`small ${seconds > max ? 'warn' : 'muted'}`}>{chosen.length} parts · {Math.round(seconds)}s of footage{seconds > max ? ` (max ${max}s)` : ''}</span>
        <button className="btn sm primary" disabled={busy || chosen.length < 2 || chosen.length > maxParts || seconds > max} onClick={create}>🎬 Create mission Short</button>
      </div>
    </section>
  );
}
