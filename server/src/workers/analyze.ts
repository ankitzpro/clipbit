/** Chunk analysis: transcript + audio/visual signals -> AI moment detection -> (optional) auto clip. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { DelayedError, type Job } from 'bullmq';
import { config } from '../config.js';
import { one, q } from '../db/pool.js';
import { logger, errMsg } from '../lib/log.js';
import { queues, type AnalyzeJob } from '../queues.js';
import { maybeRankSession } from '../services/ai/ranking.js';
import { getSettings } from '../settings.js';
import { extractAudioWav, loudnessPerSecond, readGrayFrames, activityPerSecond, makeAnalysisProxy } from '../services/video/media.js';
import { transcribe } from '../services/ai/transcribe.js';
import { computeSignals, hypeHits } from '../services/ai/signals.js';
import { heuristicMoments, overlap } from '../services/ai/heuristic.js';
import { CATEGORIES, GeminiQuotaError } from '../services/ai/gemini.js';
import { anyProviderAvailable, detectMoments } from '../services/ai/providers.js';
import { refineBoundaries, transcriptText } from '../services/ai/boundaries.js';
import { getLearningProfile } from '../services/learning.js';
import { computeScore } from '../services/ai/scoring.js';
import { createClipFromMoment, normalizeTag, sessionTranscript } from '../services/clips.js';
import type { MomentCandidate, Segment } from '../services/ai/types.js';

const log = logger('analyze');

export async function processAnalyze(job: Job<AnalyzeJob>, token?: string) {
  const chunk = await one<any>(
    `SELECT c.*, s.active AS session_active, s.heatmap AS session_heatmap, st.name AS stream_name, st.kind AS stream_kind
       FROM chunks c JOIN sessions s ON s.id = c.session_id JOIN streams st ON st.id = c.stream_id WHERE c.id = $1`,
    [job.data.chunkId],
  );
  if (!chunk || chunk.status === 'analyzed' || chunk.status === 'purged') return;
  const settings = await getSettings();
  await q(`UPDATE chunks SET status = 'analyzing', error = NULL WHERE id = $1`, [chunk.id]);

  const work = path.join(config.dirs.work, `analyze-${chunk.id}`);
  await fs.mkdir(work, { recursive: true });
  try {
    // 1) transcript
    const wav = await extractAudioWav(chunk.file, path.join(work, 'audio.wav')).catch(() => null);
    const transcript: Segment[] = wav ? await transcribe(wav, chunk.start_sec, settings.transcription, settings.language) : [];
    await job.updateProgress(35);

    // 2) signals
    const loud = await loudnessPerSecond(chunk.file);
    const act = activityPerSecond(await readGrayFrames(chunk.file, 2, 64, 36));
    const prev = await q<{ signals: any }>(
      `SELECT signals FROM chunks WHERE session_id = $1 AND idx < $2 AND signals IS NOT NULL ORDER BY idx DESC LIMIT 4`,
      [chunk.session_id, chunk.idx],
    );
    const history = prev.reverse().flatMap((p) => p.signals?.loudness || []);
    const signals = computeSignals(chunk.start_sec, loud, act, transcript, history);
    await q(`UPDATE chunks SET transcript = $2, signals = $3 WHERE id = $1`, [chunk.id, JSON.stringify(transcript), JSON.stringify(signals)]);
    await job.updateProgress(50);

    // 3) moment detection
    const duration = chunk.end_sec - chunk.start_sec;
    const sessionBounds = await one<{ min: number; max: number }>(`SELECT min(start_sec) AS min, max(end_sec) AS max FROM chunks WHERE session_id = $1`, [chunk.session_id]);
    const bounds = {
      min: settings.clipMin,
      max: settings.clipMax,
      minStart: sessionBounds?.min ?? 0,
      // a live session keeps growing: allow moments to extend a little past what's recorded so far
      maxEnd: chunk.session_active ? chunk.end_sec + 25 : sessionBounds?.max ?? chunk.end_sec,
    };
    const context = await sessionTranscript(chunk.session_id, chunk.start_sec - 45, chunk.end_sec + 1);
    const ctxTranscript = mergeTranscripts(context, transcript);
    const learning = await getLearningProfile().catch(() => undefined);
    let candidates: MomentCandidate[] = [];
    const aiReady = await anyProviderAvailable();
    let useHeuristic = !aiReady && settings.heuristicFallback;
    let provider = '';
    const prevMission = await one<{ mission: string | null }>(
      `SELECT mission FROM chunks WHERE session_id = $1 AND idx < $2 AND mission IS NOT NULL ORDER BY idx DESC LIMIT 1`,
      [chunk.session_id, chunk.idx],
    );
    let mission: string | null = prevMission?.mission ?? null;

    // quota saver: quiet chunks (no audio/visual spike, no excited speech) are not sent to Gemini
    const strongest = signals.peaks[0]?.strength ?? 0;
    const hype = hypeHits(transcript.map((t) => t.text).join(' '));
    const worthAsking = !settings.aiBudget.prefilter || strongest >= settings.aiBudget.minPeakStrength || hype >= 2;

    if (aiReady && worthAsking) {
      try {
        const proxy = await makeAnalysisProxy(chunk.file, path.join(work, 'proxy.mp4'));
        const res = await detectMoments({
          proxyFile: proxy, chunkStart: chunk.start_sec, duration, transcript: ctxTranscript.filter((s) => s.end > chunk.start_sec),
          signals, context: settings.contentContext, styles: settings.styles, maxMoments: settings.maxMomentsPerChunk,
          clipMin: settings.clipMin, clipMax: settings.clipMax, learning, previousMission: mission,
        }, settings);
        provider = res.provider;
        if (res.mission) mission = res.mission;
        candidates = res.moments.map((m) => {
          const peak = chunk.start_sec + (Number.isFinite(m.peak_sec) ? m.peak_sec : (m.start_sec + m.end_sec) / 2);
          const { start, end } = refineBoundaries(chunk.start_sec + m.start_sec, chunk.start_sec + m.end_sec, peak, ctxTranscript, bounds);
          const category = (CATEGORIES as readonly string[]).includes(m.category) ? m.category : 'other';
          // evidence-based: AI checklist + measured signals + the owner's star-rating taste (not the AI's own number)
          const { score: computed, breakdown } = computeScore({
            evidence: m.evidence, signals, transcript: ctxTranscript, start, end, category,
            aiGuess: m.viral_score, taste: learning?.categoryStars, heatmap: chunk.session_heatmap,
          });
          let score = computed;
          if (settings.styles.includes('viral_only')) score = Math.round(score * 0.95);
          return {
            start, end, peak,
            title: String(m.title || 'Untitled moment').slice(0, 95),
            description: String(m.description || ''),
            category,
            score,
            breakdown,
            hashtags: (m.hashtags || []).map(normalizeTag).filter(Boolean).slice(0, 6),
            keywords: (m.keywords || []).slice(0, 4),
            transcript: m.transcript_excerpt || transcriptText(ctxTranscript, start, end),
            detector: res.provider as 'gemini',
          };
        });
      } catch (e) {
        if (e instanceof GeminiQuotaError) {
          // out of quota: try this chunk again later instead of inventing placeholder moments
          const ageH = (Date.now() - new Date(chunk.created_at).getTime()) / 3_600_000;
          if (ageH < 24) {
            await q(`UPDATE chunks SET status = 'pending', error = 'Waiting for Gemini quota — will retry' WHERE id = $1`, [chunk.id]);
            log.warn(`gemini quota exhausted; chunk ${chunk.idx} of ${chunk.stream_name} will retry in 20 min`);
            await job.moveToDelayed(Date.now() + 20 * 60_000, token);
            throw new DelayedError();
          }
        }
        if (!settings.heuristicFallback) throw e;
        useHeuristic = true;
        log.warn(`AI analysis failed for chunk ${chunk.idx} of ${chunk.stream_name}, using heuristic: ${errMsg(e)}`);
      }
    }
    if (useHeuristic) {
      candidates = heuristicMoments(signals, ctxTranscript, {
        ...bounds, maxMoments: settings.maxMomentsPerChunk, defaultHashtags: settings.publish.defaultHashtags, learning,
      });
    }
    if (mission) await q(`UPDATE chunks SET mission = $2 WHERE id = $1`, [chunk.id, mission]);
    await job.updateProgress(85);

    // 4) keep good, non-duplicate moments
    const existing = await q<{ id: string; start_sec: number; end_sec: number; score: number }>(
      `SELECT id, start_sec, end_sec, score FROM moments WHERE session_id = $1 AND end_sec > $2 AND start_sec < $3`,
      [chunk.session_id, chunk.start_sec - 90, chunk.end_sec + 90],
    );
    let created = 0;
    for (const c of candidates.sort((a, b) => b.score - a.score)) {
      if (c.score < settings.minScore) continue;
      if (existing.some((e) => overlap(e.start_sec, e.end_sec, c.start, c.end) > 0.5)) continue;
      const row = await one<{ id: string }>(
        `INSERT INTO moments (stream_id, session_id, chunk_id, start_sec, end_sec, peak_sec, title, description, category, score, hashtags, keywords, transcript, detector, mission, score_breakdown)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [chunk.stream_id, chunk.session_id, chunk.id, c.start, c.end, c.peak, c.title, c.description, c.category, c.score, c.hashtags, c.keywords, c.transcript, c.detector, mission,
          c.breakdown ? JSON.stringify(c.breakdown) : null],
      );
      existing.push({ id: row!.id, start_sec: c.start, end_sec: c.end, score: c.score });
      created++;
      if (settings.autoClip && c.score >= settings.autoClipMinScore) await createClipFromMoment(row!.id, settings);
    }

    await q(`UPDATE chunks SET status = 'analyzed' WHERE id = $1`, [chunk.id]);
    log.info(`chunk ${chunk.idx} of "${chunk.stream_name}": ${transcript.length} speech segments, ${signals.peaks.length} peaks, ${worthAsking && aiReady ? `analysed by ${provider || '?'}` : 'quiet (skipped AI)'}, mission "${mission || '-'}", ${created} new moments`);
    await maybeCompleteStream(chunk.stream_id, chunk.session_id);
    // compare all moments of the session side by side once nothing is pending (live: every ~5 chunks)
    await maybeRankSession(chunk.session_id, chunk.idx, (sessionId) =>
      queues.maintenance.add('rank-session', { sessionId }, { jobId: `rank-${sessionId}-${chunk.id}`, delay: 15_000 }).then(() => undefined),
    ).catch((e) => log.warn(`could not queue ranking: ${errMsg(e)}`));
  } catch (e) {
    if (e instanceof DelayedError) throw e;
    const final = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    await q(`UPDATE chunks SET status = $3, error = $2 WHERE id = $1`, [chunk.id, errMsg(e).slice(0, 500), final ? 'failed' : 'pending']);
    throw e;
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

function mergeTranscripts(a: Segment[], b: Segment[]) {
  const all = [...a.filter((s) => !b.some((x) => Math.abs(x.start - s.start) < 0.3)), ...b];
  return all.sort((x, y) => x.start - y.start);
}

/** VOD / file sessions are "completed" once every chunk has been analysed. */
async function maybeCompleteStream(streamId: string, sessionId: string) {
  const s = await one<any>(
    `SELECT st.kind, se.active,
            (SELECT count(*) FROM chunks c WHERE c.session_id = se.id AND c.status IN ('pending','analyzing'))::int AS pending
       FROM sessions se JOIN streams st ON st.id = se.stream_id WHERE se.id = $1`,
    [sessionId],
  );
  if (s && (s.kind === 'vod' || s.kind === 'file') && !s.active && s.pending === 0) {
    await q(`UPDATE streams SET status = 'completed', updated_at = now() WHERE id = $1`, [streamId]);
  }
}
