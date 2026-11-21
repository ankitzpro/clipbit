/** Clip render worker: builds the vertical Short for a clip version and stores it. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { DelayedError, type Job } from 'bullmq';
import { config } from '../config.js';
import { one, q } from '../db/pool.js';
import { logger, errMsg } from '../lib/log.js';
import { storage } from '../lib/storage.js';
import type { RenderJob } from '../queues.js';
import { getSettings } from '../settings.js';
import { renderClip, renderSourcePreview, concatShorts } from '../services/video/render.js';
import { sessionTranscript } from '../services/clips.js';
import { planEdit, type EditPlan } from '../services/ai/editplan.js';
import { listSfx, pickSfx } from '../services/video/sfx.js';
import { brandingFile } from '../services/video/branding.js';

const log = logger('render');

export async function processRender(job: Job<RenderJob>, token?: string) {
  const clip = await one<any>(
    `SELECT c.*, s.active AS session_active, st.options AS stream_options, m.peak_sec
       FROM clips c LEFT JOIN sessions s ON s.id = c.session_id LEFT JOIN streams st ON st.id = c.stream_id
       LEFT JOIN moments m ON m.id = c.moment_id WHERE c.id = $1`,
    [job.data.clipId],
  );
  if (!clip || clip.version !== job.data.version) return; // stale job (clip edited again or deleted)
  if (!clip.session_id) throw new Error('source recording no longer exists');

  const chunks = await q<{ file: string; start_sec: number; end_sec: number; status: string }>(
    `SELECT file, start_sec, end_sec, status FROM chunks WHERE session_id = $1 AND status <> 'purged' ORDER BY start_sec`,
    [clip.session_id],
  );
  const recordedEnd = chunks.length ? chunks[chunks.length - 1].end_sec : 0;
  // a normal clip is one part; a mission Short is several parts from the same recording
  type Part = { start: number; end: number; peak?: number };
  let parts: Part[] = Array.isArray(clip.parts) && clip.parts.length
    ? clip.parts.map((p: any) => ({ start: Number(p.start), end: Number(p.end), peak: p.peak != null ? Number(p.peak) : undefined }))
    : [{ start: clip.start_sec, end: clip.end_sec, peak: clip.peak_sec ?? undefined }];
  parts.sort((a, b) => a.start - b.start);
  const lastEnd = parts[parts.length - 1].end;
  if (lastEnd > recordedEnd + 0.05) {
    if (clip.session_active && Date.now() - new Date(clip.created_at).getTime() < 15 * 60_000) {
      // live: wait for the next chunk to finish recording
      await job.moveToDelayed(Date.now() + 20_000, token);
      throw new DelayedError();
    }
  }
  const firstStart = chunks[0]?.start_sec ?? 0;
  parts = parts
    .map((p) => ({ ...p, start: Math.max(p.start, firstStart), end: Math.min(p.end, recordedEnd) }))
    .filter((p) => p.end - p.start >= 2);
  if (!chunks.length || !parts.length) throw new Error('recording for this clip is no longer available');
  const start = parts[0].start;
  const end = parts[parts.length - 1].end;
  for (const c of chunks.filter((c) => parts.some((p) => c.end_sec > p.start && c.start_sec < p.end))) {
    await fs.access(c.file).catch(() => {
      throw new Error('source recording was deleted (retention policy) — cannot re-render');
    });
  }
  const isMission = parts.length > 1 || clip.kind === 'mission';

  const settings = await getSettings();
  const opts = clip.options || {};
  await q(`UPDATE clips SET status = 'rendering', progress = 1, error = NULL, updated_at = now() WHERE id = $1`, [clip.id]);

  let transcriptSegs = clip.captions?.segments;
  if (!transcriptSegs) {
    transcriptSegs = [];
    for (const p of parts) transcriptSegs.push(...(await sessionTranscript(clip.session_id, p.start, p.end)));
  }
  const ai = settings.aiEdit;
  const useHook = opts.hook ?? ai.hook;
  const useSfx = opts.sfx ?? ai.sfx;
  const useSmartCaptions = (opts.smartCaptions ?? ai.smartCaptions) && !clip.captions?.edited;

  // AI edit plan (hook, title, caption fixes, sfx cues) — reused across re-renders unless the trim changed
  const sfxLib = await listSfx().catch((e) => {
    log.warn(`sound effects unavailable: ${errMsg(e)}`);
    return {} as Record<string, string[]>;
  });
  let plan: EditPlan | null = clip.edit_plan || null;
  const stale = plan && !plan.userEdited && (Math.abs((plan.forStart ?? start) - start) > 0.5 || Math.abs((plan.forEnd ?? end) - end) > 0.5);
  if ((useHook || useSfx || useSmartCaptions) && (!plan || stale)) {
    await q(`UPDATE clips SET progress = 3 WHERE id = $1`, [clip.id]);
    // low-res copy of exactly what will be in the Short, so Gemini can watch it before writing the hook/title
    const proxyDir = path.join(config.dirs.work, `plan-${clip.id}-v${clip.version}`);
    await fs.mkdir(proxyDir, { recursive: true });
    let videoFile: string | null = null;
    try {
      const pieces: string[] = [];
      for (const [i, p] of parts.entries()) {
        pieces.push(await renderSourcePreview(chunks.filter((c) => c.end_sec > p.start && c.start_sec < p.end), p.start, p.end, path.join(proxyDir, `p${i}.mp4`)));
      }
      videoFile = pieces.length === 1 ? pieces[0] : await concatShorts(pieces, path.join(proxyDir, 'all.mp4'));
    } catch (e) {
      log.warn(`could not build AI preview: ${errMsg(e)}`);
    }
    plan = await planEdit({
      videoFile,
      start, end, peak: isMission ? null : clip.peak_sec, title: clip.title,
      description: isMission ? `A ${parts.length}-part montage of the best moments from the mission "${clip.mission || clip.title}". ${clip.description || ''}` : clip.description,
      category: clip.category,
      keywords: opts.keywords || [], segments: transcriptSegs, context: settings.contentContext,
      // mission Shorts get a whoosh on every cut instead of AI-placed effects (their timeline is compressed)
      sfxTypes: Object.keys(sfxLib), maxSfx: isMission ? 0 : ai.maxSfx, smartCaptions: useSmartCaptions,
      provider: settings.aiProvider.edit,
    });
    await fs.rm(proxyDir, { recursive: true, force: true }).catch(() => {});
    plan.forStart = start;
    plan.forEnd = end;
    // replace placeholder titles with the AI's title after watching the clip
    if (plan.title && (opts.autoTitle || /wild moment at|moment at \d/i.test(clip.title) || clip.title === plan.hook)) {
      await q(`UPDATE clips SET title = $2, options = options - 'autoTitle' WHERE id = $1`, [clip.id, plan.title]);
    }
    await q(`UPDATE clips SET edit_plan = $2 WHERE id = $1 AND version = $3`, [clip.id, JSON.stringify(plan), clip.version]);
  }
  const captionsSegs = useSmartCaptions && plan?.captions?.length ? plan.captions : transcriptSegs;
  const keywords = [...new Set([...(plan?.keywords || []), ...(opts.keywords || [])])];
  const planSfx = useSfx && plan
    ? plan.sfx.map((c) => ({ t: c.t, file: pickSfx(sfxLib, c.type, `${clip.id}-${c.type}-${c.t}`) })).filter((c): c is { t: number; file: string } => !!c.file)
    : [];
  const work = path.join(config.dirs.work, `render-${clip.id}-v${clip.version}`);
  let lastReport = 0;
  const report = (p: number) => {
    if (Date.now() - lastReport > 1500 || p === 100) {
      lastReport = Date.now();
      void q(`UPDATE clips SET progress = $2 WHERE id = $1 AND version = $3`, [clip.id, p, clip.version]);
      void job.updateProgress(p);
    }
  };
  try {
    const renderOptions = {
      reframeMode: opts.reframeMode || clip.stream_options?.reframeMode || settings.reframeMode,
      facecam: opts.facecam || clip.stream_options?.facecam || null,
      captions: { ...settings.captions, enabled: opts.captions ?? settings.captions.enabled },
      deadAir: { ...settings.deadAir, enabled: opts.deadAir ?? settings.deadAir.enabled },
      video: settings.video,
      minDuration: isMission ? 3 : settings.clipMin,
    };
    const whoosh = useSfx ? pickSfx(sfxLib, 'whoosh', `${clip.id}-cut`) : null;
    const outputs: { file: string; thumb: string; duration: number }[] = [];
    for (const [i, p] of parts.entries()) {
      const res = await renderClip({
        chunks,
        start: p.start,
        end: p.end,
        peak: p.peak,
        captions: captionsSegs,
        keywords,
        hook: i === 0 && useHook && plan?.hook ? { text: plan.hook, seconds: ai.hookSeconds } : null,
        sfx: [
          ...planSfx.filter((c) => c.t >= p.start && c.t < p.end),
          ...(isMission && i > 0 && whoosh ? [{ t: p.start + 0.01, file: whoosh }] : []),
        ],
        sfxVolume: ai.sfxVolume,
        intro: i === 0 ? brandingFile(settings, 'intro', opts.intro) : null,
        outro: i === parts.length - 1 ? brandingFile(settings, 'outro', opts.outro) : null,
        workDir: parts.length > 1 ? path.join(work, `part${i}`) : work,
        options: renderOptions,
        onProgress: (pct) => report(Math.round(((i + pct / 100) / parts.length) * (parts.length > 1 ? 96 : 100))),
      });
      outputs.push(res);
    }
    const res = outputs.length === 1
      ? outputs[0]
      : { file: await concatShorts(outputs.map((o) => o.file), path.join(work, 'short.mp4')), thumb: outputs[0].thumb, duration: outputs.reduce((a, o) => a + o.duration, 0) };

    const fileKey = `clips/${clip.id}/v${clip.version}.mp4`;
    const thumbKey = `clips/${clip.id}/v${clip.version}.jpg`;
    await storage.put(res.file, fileKey, 'video/mp4');
    await storage.put(res.thumb, thumbKey, 'image/jpeg');

    const updated = await one<{ id: string }>(
      `UPDATE clips SET status = 'ready', progress = 100, duration = $2, file_key = $3, thumb_key = $4, end_sec = $5, updated_at = now()
        WHERE id = $1 AND version = $6 RETURNING id`,
      [clip.id, res.duration, fileKey, thumbKey, end, clip.version],
    );
    if (!updated) {
      // edited while rendering: discard this output
      await storage.remove(fileKey).catch(() => {});
      await storage.remove(thumbKey).catch(() => {});
    } else {
      if (clip.file_key && clip.file_key !== fileKey) await storage.remove(clip.file_key).catch(() => {});
      if (clip.thumb_key && clip.thumb_key !== thumbKey) await storage.remove(clip.thumb_key).catch(() => {});
    }
    log.info(`clip ${clip.id} v${clip.version} ready (${res.duration.toFixed(1)}s)`);
  } catch (e) {
    const final = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    await q(`UPDATE clips SET status = $2, error = $3, updated_at = now() WHERE id = $1 AND version = $4`, [
      clip.id, final ? 'failed' : 'queued', errMsg(e).slice(0, 500), clip.version,
    ]);
    throw e;
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
