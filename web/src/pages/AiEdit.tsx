import { useEffect, useState } from 'react';
import { api, type ClipDetail } from '../api';
import { useAction, usePoll } from '../hooks';

/** Hook banner + sound-effect cues planned by the AI editor; everything is editable. */
export function AiEditPanel({ clip, onQueued }: { clip: ClipDetail; onQueued: () => void }) {
  const plan = clip.edit_plan;
  const { data: sfxTypes } = usePoll<{ type: string; files: number; builtin: boolean }[]>('/api/sfx', 0);
  const [hook, setHook] = useState(plan?.hook || '');
  const [cues, setCues] = useState(plan?.sfx || []);
  const [hookOn, setHookOn] = useState(clip.options?.hook ?? true);
  const [sfxOn, setSfxOn] = useState(clip.options?.sfx ?? true);
  const [smartCaps, setSmartCaps] = useState(clip.options?.smartCaptions ?? true);
  const { busy, run } = useAction();

  useEffect(() => {
    setHook(clip.edit_plan?.hook || '');
    setCues(clip.edit_plan?.sfx || []);
  }, [clip.id, clip.version, clip.edit_plan?.createdAt]);

  const rel = (t: number) => +(t - clip.start_sec).toFixed(1);
  const dirty =
    hook !== (plan?.hook || '') ||
    JSON.stringify(cues) !== JSON.stringify(plan?.sfx || []) ||
    hookOn !== (clip.options?.hook ?? true) ||
    sfxOn !== (clip.options?.sfx ?? true) ||
    smartCaps !== (clip.options?.smartCaptions ?? true);
  const rendering = clip.status === 'rendering' || clip.status === 'queued';

  const apply = () =>
    run(async () => {
      await api.post(`/api/clips/${clip.id}/regenerate`, {
        hook,
        sfx: cues,
        hookEnabled: hookOn,
        sfxEnabled: sfxOn,
        smartCaptions: smartCaps,
      });
      onQueued();
    }, 'Applying edits — re-rendering');

  const replan = () =>
    run(async () => {
      await api.post(`/api/clips/${clip.id}/regenerate`, { replanAi: true, hookEnabled: hookOn, sfxEnabled: sfxOn, smartCaptions: smartCaps });
      onQueued();
    }, 'Asking the AI for a fresh edit — re-rendering');

  return (
    <section className="card">
      <div className="card-head">
        <h3>
          AI edit{' '}
          <span className="muted small">
            {plan ? (plan.source === 'gemini' ? '· planned by Gemini' : plan.source === 'user' ? '· your edits' : '· basic (no Gemini key)') : rendering ? '· planning…' : ''}
          </span>
        </h3>
        <button className="btn sm ghost" disabled={busy || clip.status === 'published'} onClick={replan}>✨ Re-plan with AI</button>
      </div>

      <div className="grid3">
        <label className="check"><input type="checkbox" checked={hookOn} onChange={(e) => setHookOn(e.target.checked)} /> Hook title</label>
        <label className="check"><input type="checkbox" checked={smartCaps} onChange={(e) => setSmartCaps(e.target.checked)} /> AI-cleaned captions</label>
        <label className="check"><input type="checkbox" checked={sfxOn} onChange={(e) => setSfxOn(e.target.checked)} /> Sound effects</label>
      </div>

      {hookOn && (
        <label className="mt">Hook banner (first seconds)
          <input value={hook} maxLength={60} onChange={(e) => setHook(e.target.value.toUpperCase())} placeholder="HE DID NOT SEE THIS COMING" />
        </label>
      )}

      {sfxOn && (
        <div className="mt">
          <div className="muted small">Sound effects (seconds from clip start)</div>
          <div className="caption-list">
            {cues.length === 0 && <p className="muted small">No effects planned.</p>}
            {cues.map((c, i) => (
              <div key={i} className="sfx-row">
                <input type="number" step="0.1" min={0} value={rel(c.t)} onChange={(e) => setCues(cues.map((x, j) => (j === i ? { ...x, t: clip.start_sec + Number(e.target.value) } : x)))} />
                <select value={c.type} onChange={(e) => setCues(cues.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}>
                  {(sfxTypes || [{ type: c.type, files: 1, builtin: true }]).map((t) => <option key={t.type} value={t.type}>{t.type}{t.builtin ? '' : ' (yours)'}</option>)}
                </select>
                <button className="icon-btn" title="Remove" onClick={() => setCues(cues.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
          </div>
          <button className="btn xs ghost" onClick={() => setCues([...cues, { t: clip.start_sec + 1, type: sfxTypes?.[0]?.type || 'whoosh' }].sort((a, b) => a.t - b.t))}>+ Add effect</button>
          <p className="muted small">Add your own sounds in <code>D:\clipforge-data\sfx\&lt;type&gt;\</code> (e.g. <code>laugh</code>, <code>airhorn</code>). Only use sounds you have rights to.</p>
        </div>
      )}

      <div className="row end gap">
        <button className="btn sm primary" disabled={!dirty || busy || clip.status === 'published'} onClick={apply}>Apply & re-render</button>
      </div>
    </section>
  );
}
