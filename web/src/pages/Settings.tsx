import { useEffect, useState } from 'react';
import { api } from '../api';
import { toast, useAction, usePoll } from '../hooks';
import { PageHead, Progress } from '../ui';

const STYLES = [
  ['funny', 'Funny moments'],
  ['action', 'Action-packed gameplay'],
  ['unexpected', 'Unexpected moments'],
  ['reactions', 'Reactions'],
  ['commentary', 'Commentary & conversation'],
  ['viral_only', 'High viral potential only'],
] as const;

export function Settings({ query }: { query: URLSearchParams }) {
  const { data: saved, reload } = usePoll<any>('/api/settings', 0);
  const { data: sys, reload: reloadSys } = usePoll<any>('/api/system', 0);
  const [s, setS] = useState<any>(null);
  const { busy, run } = useAction();

  useEffect(() => {
    if (saved) setS(structuredClone(saved));
  }, [saved]);
  useEffect(() => {
    const yt = query.get('yt');
    if (yt === 'connected') toast('YouTube channel connected');
    else if (yt) toast(`YouTube connection failed: ${yt}`, 'err');
    if (yt) window.history.replaceState(null, '', '#/settings');
  }, []);

  if (!s || !sys) return <PageHead title="Settings" sub="Loading…" />;
  const set = (path: string, value: any) => {
    const next = structuredClone(s);
    const keys = path.split('.');
    let o = next;
    for (const k of keys.slice(0, -1)) o = o[k];
    o[keys[keys.length - 1]] = value;
    setS(next);
  };
  const dirty = JSON.stringify(s) !== JSON.stringify(saved);
  const save = () => run(async () => { await api.put('/api/settings', s); await reload(); }, 'Settings saved');
  const num = (path: string, v: string) => set(path, Number(v));

  return (
    <>
      <PageHead title="Settings" sub="Tune detection, video output, captions and publishing."
        actions={<button className="btn primary" disabled={!dirty || busy} onClick={save}>{dirty ? 'Save changes' : 'Saved'}</button>} />

      <section className="card">
        <h2>YouTube channel</h2>
        {!sys.youtubeConfigured ? (
          <div className="notice">
            Add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> to your <code>.env</code> (OAuth client type "Web application", redirect URI <code>{location.origin}/api/youtube/callback</code>) and restart. See README → "Connect YouTube".
          </div>
        ) : sys.youtubeAccount ? (
          <div className="row gap">
            {sys.youtubeAccount.thumbnail && <img className="avatar" src={sys.youtubeAccount.thumbnail} alt="" />}
            <div className="grow"><b>{sys.youtubeAccount.title}</b><div className="muted small">Connected · uploads go to this channel</div></div>
            <button className="btn ghost danger" onClick={() => confirm('Disconnect this channel?') && run(async () => { await api.post('/api/youtube/disconnect'); await reloadSys(); }, 'Disconnected')}>Disconnect</button>
          </div>
        ) : (
          <div className="row gap"><p className="grow muted">Connect your channel to upload approved clips directly.</p><a className="btn primary" href="/api/youtube/auth">Connect YouTube</a></div>
        )}
        <div className="grid3 mt">
          <label>Default visibility
            <select value={s.publish.defaultPrivacy} onChange={(e) => set('publish.defaultPrivacy', e.target.value)}>
              <option value="private">Private</option><option value="unlisted">Unlisted</option><option value="public">Public</option>
            </select>
          </label>
          <label>Default hashtags<input value={s.publish.defaultHashtags.join(' ')} onChange={(e) => set('publish.defaultHashtags', e.target.value.split(/[\s,]+/).filter(Boolean))} /></label>
          <label className="check"><input type="checkbox" checked={s.publish.appendShortsTag} onChange={(e) => set('publish.appendShortsTag', e.target.checked)} /> Always add #Shorts</label>
        </div>
      </section>

      <section className="card">
        <h2>AI moment detection</h2>
        <div className="status-row">
          <span className={sys.gemini ? 'ok' : 'warn'}>{sys.gemini ? '●' : '○'} Gemini {sys.gemini ? `(${sys.geminiModel})` : 'no key'}{sys.geminiHealth && !sys.geminiHealth.ok ? ' — last call failed' : ''}</span>
          <span className={sys.ollama?.ready ? 'ok' : 'warn'}>{sys.ollama?.ready ? '●' : '○'} Ollama {sys.ollama?.ready ? `(${sys.ollama.model}, on this PC)` : sys.ollama?.error || 'not reachable'}</span>
          <span className={sys.whisper ? 'ok' : 'warn'}>{sys.whisper ? '●' : '○'} Whisper {sys.whisper ? 'ready' : 'unavailable'}</span>
          <span className={sys.ytdlp ? 'ok' : 'warn'}>{sys.ytdlp ? '●' : '○'} yt-dlp {sys.ytdlp || 'missing'}</span>
        </div>
        <div className="grid3">
          <label>Finding moments (every analysed minute)
            <select value={s.aiProvider.detect} onChange={(e) => set('aiProvider.detect', e.target.value)}>
              <option value="ollama">Ollama — local, free, no quota</option>
              <option value="gemini">Gemini — best quality, uses quota</option>
            </select>
          </label>
          <label>Hooks, titles & captions (only clips you render)
            <select value={s.aiProvider.edit} onChange={(e) => set('aiProvider.edit', e.target.value)}>
              <option value="gemini">Gemini — watches the clip, best hooks</option>
              <option value="ollama">Ollama — local, free</option>
            </select>
          </label>
          <label>Ollama model<input value={s.ollamaModel} onChange={(e) => set('ollamaModel', e.target.value)} placeholder={sys.ollama?.model || 'qwen2.5vl:3b'} /></label>
        </div>
        <p className="muted small">If the chosen provider fails (e.g. Gemini quota), the other one is used automatically. Installed Ollama models: {sys.ollama?.models?.join(', ') || '—'}</p>
        <label>Content context (tells the AI what it's watching)<input value={s.contentContext} onChange={(e) => set('contentContext', e.target.value)} /></label>
        <div className="muted small mt">Preferred content style</div>
        <div className="chips">
          {STYLES.map(([k, label]) => (
            <label key={k} className={`chip-toggle ${s.styles.includes(k) ? 'on' : ''}`}>
              <input type="checkbox" checked={s.styles.includes(k)} onChange={(e) => set('styles', e.target.checked ? [...s.styles, k] : s.styles.filter((x: string) => x !== k))} />
              {label}
            </label>
          ))}
        </div>
        <div className="grid3 mt">
          <label>Keep moments scoring ≥ <b>{s.minScore}</b><input type="range" min={0} max={95} step={5} value={s.minScore} onChange={(e) => num('minScore', e.target.value)} /></label>
          <label>Auto-render clips scoring ≥ <b>{s.autoClipMinScore}</b><input type="range" min={0} max={100} step={5} value={s.autoClipMinScore} onChange={(e) => num('autoClipMinScore', e.target.value)} disabled={!s.autoClip} /></label>
          <label className="check"><input type="checkbox" checked={s.autoClip} onChange={(e) => set('autoClip', e.target.checked)} /> Auto-generate clips</label>
          <label>Max moments per {s.chunkSeconds}s chunk<input type="number" min={1} max={5} value={s.maxMomentsPerChunk} onChange={(e) => num('maxMomentsPerChunk', e.target.value)} /></label>
          <label>Clip length min (s)<input type="number" min={5} max={60} value={s.clipMin} onChange={(e) => num('clipMin', e.target.value)} /></label>
          <label>Clip length max (s)<input type="number" min={10} max={180} value={s.clipMax} onChange={(e) => num('clipMax', e.target.value)} /></label>
          <label>Analysis chunk length (s)<input type="number" min={30} max={180} value={s.chunkSeconds} onChange={(e) => num('chunkSeconds', e.target.value)} /></label>
          <label>Speech recognition
            <select value={s.transcription} onChange={(e) => set('transcription', e.target.value)}>
              <option value="whisper">Whisper (local)</option><option value="gemini">Gemini</option><option value="none">Off</option>
            </select>
          </label>
          <label>Spoken language<input value={s.language} onChange={(e) => set('language', e.target.value)} placeholder="auto, en, hi…" /></label>
          <label className="check"><input type="checkbox" checked={s.aiBudget.prefilter} onChange={(e) => set('aiBudget.prefilter', e.target.checked)} /> Save Gemini quota: skip quiet chunks</label>
          <label className="check"><input type="checkbox" checked={s.heuristicFallback} onChange={(e) => set('heuristicFallback', e.target.checked)} /> Basic detector when Gemini is unavailable (generic titles)</label>
          <label>Mission Short target length (s)<input type="number" min={20} max={170} value={s.missionShort.targetSeconds} onChange={(e) => num('missionShort.targetSeconds', e.target.value)} /></label>
          <label>Gemini model override<input value={s.geminiModel} onChange={(e) => set('geminiModel', e.target.value)} placeholder={sys.geminiModel} /></label>
        </div>
      </section>

      <section className="card">
        <h2>Video output</h2>
        <div className="grid3">
          <label>Default framing (16:9 → 9:16)
            <select value={s.reframeMode} onChange={(e) => set('reframeMode', e.target.value)}>
              <option value="smart">Smart crop — follow the action</option>
              <option value="blur">Fit with blurred background</option>
              <option value="center">Center crop</option>
              <option value="split">Facecam + gameplay (set facecam per stream)</option>
            </select>
          </label>
          <label>Quality (CRF, lower = better)<input type="number" min={14} max={30} value={s.video.crf} onChange={(e) => num('video.crf', e.target.value)} /></label>
          <label>Encoder speed
            <select value={s.video.preset} onChange={(e) => set('video.preset', e.target.value)}>
              {['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow'].map((p) => <option key={p}>{p}</option>)}
            </select>
          </label>
          <label>Frame rate<select value={s.video.fps} onChange={(e) => num('video.fps', e.target.value)}><option value={30}>30</option><option value={60}>60</option></select></label>
          <label className="check"><input type="checkbox" checked={s.deadAir.enabled} onChange={(e) => set('deadAir.enabled', e.target.checked)} /> Remove dead air</label>
          <label>Silence longer than (s)<input type="number" step="0.1" min={0.6} max={5} value={s.deadAir.minSilence} onChange={(e) => num('deadAir.minSilence', e.target.value)} /></label>
          <label>Keep raw recordings (hours)<input type="number" min={1} max={720} value={s.retention.keepRecordingsHours} onChange={(e) => num('retention.keepRecordingsHours', e.target.value)} /></label>
        </div>
        <p className="muted small">Output is always 1080×1920 H.264 + AAC, loudness-normalised to −14 LUFS (YouTube's target).</p>
      </section>

      <BrandingSection />

      <section className="card">
        <h2>AI editing</h2>
        <p className="muted small">Applied to every new clip; each clip can be tweaked in Clip Studio. Uses Gemini when a key is set.</p>
        <div className="grid3">
          <label className="check"><input type="checkbox" checked={s.aiEdit.hook} onChange={(e) => set('aiEdit.hook', e.target.checked)} /> Hook title banner</label>
          <label>Hook shows for (s)<input type="number" step="0.1" min={1} max={6} value={s.aiEdit.hookSeconds} onChange={(e) => num('aiEdit.hookSeconds', e.target.value)} /></label>
          <label className="check"><input type="checkbox" checked={s.aiEdit.smartCaptions} onChange={(e) => set('aiEdit.smartCaptions', e.target.checked)} /> AI-cleaned captions</label>
          <label className="check"><input type="checkbox" checked={s.aiEdit.sfx} onChange={(e) => set('aiEdit.sfx', e.target.checked)} /> Sound effects</label>
          <label>Effects volume ({Math.round(s.aiEdit.sfxVolume * 100)}%)<input type="range" min={0.1} max={1.2} step={0.05} value={s.aiEdit.sfxVolume} onChange={(e) => num('aiEdit.sfxVolume', e.target.value)} /></label>
          <label>Max effects per clip<input type="number" min={0} max={8} value={s.aiEdit.maxSfx} onChange={(e) => num('aiEdit.maxSfx', e.target.value)} /></label>
        </div>
        <p className="muted small">Built-in effects: whoosh, boom, ding, riser, pop. Add your own royalty-free sounds to <code>D:\clipforge-data\sfx\&lt;type&gt;\</code> — e.g. a <code>laugh</code> folder — and the AI will start using them.</p>
      </section>

      <section className="card">
        <h2>Captions</h2>
        <div className="grid3">
          <label className="check"><input type="checkbox" checked={s.captions.enabled} onChange={(e) => set('captions.enabled', e.target.checked)} /> Burn in subtitles</label>
          <label className="check"><input type="checkbox" checked={s.captions.animated} onChange={(e) => set('captions.animated', e.target.checked)} /> Animated word highlight</label>
          <label className="check"><input type="checkbox" checked={s.captions.uppercase} onChange={(e) => set('captions.uppercase', e.target.checked)} /> UPPERCASE</label>
          <label>Font size<input type="number" min={40} max={140} value={s.captions.fontSize} onChange={(e) => num('captions.fontSize', e.target.value)} /></label>
          <label>Words per line<input type="number" min={1} max={8} value={s.captions.maxWordsPerLine} onChange={(e) => num('captions.maxWordsPerLine', e.target.value)} /></label>
          <label>Vertical position ({Math.round(s.captions.position * 100)}% down)<input type="range" min={0.3} max={0.9} step={0.02} value={s.captions.position} onChange={(e) => num('captions.position', e.target.value)} /></label>
          <label>Text colour<input type="color" value={s.captions.color} onChange={(e) => set('captions.color', e.target.value)} /></label>
          <label>Highlight colour<input type="color" value={s.captions.highlightColor} onChange={(e) => set('captions.highlightColor', e.target.value)} /></label>
          <label>Keyword colour<input type="color" value={s.captions.keywordColor} onChange={(e) => set('captions.keywordColor', e.target.value)} /></label>
          <label>Font<input value={s.captions.fontName} onChange={(e) => set('captions.fontName', e.target.value)} /></label>
        </div>
        <div className="cap-preview">
          <span style={{ fontSize: s.captions.fontSize / 3.2, color: s.captions.color, top: `${s.captions.position * 100}%` }}>
            {(s.captions.uppercase ? ['NO', 'WAY', 'HE', 'JUST'] : ['no', 'way', 'he', 'just']).map((w, i) => (
              <span key={i} style={{ color: i === 1 ? s.captions.highlightColor : i === 3 ? s.captions.keywordColor : undefined }}>{w} </span>
            ))}
          </span>
        </div>
      </section>
      {dirty && <div className="save-bar"><span>Unsaved changes</span><button className="btn ghost" onClick={() => setS(structuredClone(saved))}>Discard</button><button className="btn primary" onClick={save} disabled={busy}>Save</button></div>}
    </>
  );
}

type Brand = { slot: 'intro' | 'outro'; enabled: boolean; exists: boolean; duration: number | null; width: number | null; height: number | null; hasAudio: boolean | null; updatedAt: number | null };

function BrandingSection() {
  const { data, reload } = usePoll<Brand[]>('/api/branding', 0);
  const { busy, run } = useAction();
  const [pct, setPct] = useState<Record<string, number | null>>({});

  const upload = (slot: string, file: File) =>
    run(async () => {
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/branding/${slot}?filename=${encodeURIComponent(file.name)}`);
        xhr.setRequestHeader('content-type', 'application/octet-stream');
        xhr.upload.onprogress = (e) => e.lengthComputable && setPct((p) => ({ ...p, [slot]: Math.round((e.loaded / e.total) * 100) }));
        xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(JSON.parse(xhr.responseText || '{}').error || 'upload failed')));
        xhr.onerror = () => reject(new Error('network error'));
        xhr.send(file);
      }).finally(() => setPct((p) => ({ ...p, [slot]: null })));
      await reload();
    }, `${slot === 'intro' ? 'Intro' : 'Outro'} saved — it will be added to new renders`);

  return (
    <section className="card">
      <h2>Intro & outro</h2>
      <p className="muted small">
        Added to the start/end of every new Short (toggle per clip in Clip Studio). Any shape works — horizontal videos get a blurred vertical fill.
        Keep them short (1–3s intro, 2–5s outro): viewers swipe away fast, and YouTube Shorts must stay within the length limit.
      </p>
      <div className="brand-grid">
        {(['intro', 'outro'] as const).map((slot) => {
          const b = data?.find((x) => x.slot === slot);
          return (
            <div key={slot} className="brand-card">
              <div className="row gap">
                <b className="grow">{slot === 'intro' ? 'Intro' : 'Outro'}</b>
                {b?.exists && (
                  <label className="check small">
                    <input type="checkbox" checked={b.enabled} onChange={(e) => run(async () => { await api.patch(`/api/branding/${slot}`, { enabled: e.target.checked }); await reload(); })} /> Use by default
                  </label>
                )}
              </div>
              {b?.exists ? (
                <>
                  <video className="brand-video" src={`/api/branding/${slot}/video?v=${b.updatedAt}`} controls playsInline />
                  <div className="muted small">{b.duration?.toFixed(1)}s · {b.width}×{b.height}{b.hasAudio ? '' : ' · no audio'}</div>
                </>
              ) : (
                <div className="brand-empty muted small">No {slot} yet</div>
              )}
              {pct[slot] != null && <Progress value={pct[slot]!} />}
              <div className="row gap wrap">
                <label className="btn sm">
                  {b?.exists ? 'Replace…' : 'Upload video…'}
                  <input type="file" accept="video/*" hidden disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(slot, f); e.target.value = ''; }} />
                </label>
                {b?.exists && <button className="btn sm ghost danger" onClick={() => confirm(`Remove the ${slot}?`) && run(async () => { await api.del(`/api/branding/${slot}`); await reload(); }, 'Removed')}>Remove</button>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
