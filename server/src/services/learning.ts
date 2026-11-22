/**
 * Feedback loop: summarises what the creator approves, rejects and what performs on YouTube.
 * The profile is injected into the Gemini prompt and used to re-weight heuristic scores.
 */
import { q } from '../db/pool.js';
import type { LearningProfile } from './ai/types.js';

let cache: { at: number; value: LearningProfile } | null = null;

export async function getLearningProfile(force = false): Promise<LearningProfile> {
  if (!force && cache && Date.now() - cache.at < 10 * 60 * 1000) return cache.value;

  const rows = await q<{ category: string | null; status: string; title: string; reject_reason: string | null }>(
    `SELECT category, status, title, reject_reason FROM clips
      WHERE status IN ('approved','rejected','published') ORDER BY updated_at DESC LIMIT 500`,
  );
  const categoryApproval: LearningProfile['categoryApproval'] = {};
  for (const r of rows) {
    const c = r.category || 'other';
    categoryApproval[c] ||= { approved: 0, rejected: 0, rate: 0 };
    if (r.status === 'rejected') categoryApproval[c].rejected++;
    else categoryApproval[c].approved++;
  }
  for (const v of Object.values(categoryApproval)) v.rate = v.approved / Math.max(1, v.approved + v.rejected);

  const perf = await q<{ title: string; category: string | null; views: string }>(
    `SELECT p.title, c.category, COALESCE((p.stats->>'views')::bigint, 0) AS views
       FROM publications p JOIN clips c ON c.id = p.clip_id
      WHERE p.status = 'published' AND p.stats IS NOT NULL
      ORDER BY views DESC LIMIT 50`,
  );
  const catViews: Record<string, number[]> = {};
  for (const p of perf) (catViews[p.category || 'other'] ||= []).push(Number(p.views));

  // Owner's taste: explicit stars on a moment or its clip win; otherwise approve ≈ 4★, reject ≈ 1.5★.
  const rated = await q<{ title: string; category: string | null; stars: number; explicit: boolean }>(
    `SELECT COALESCE(c.title, m.title) AS title, COALESCE(m.category, c.category) AS category,
            COALESCE(c.user_rating, m.user_rating,
                     CASE WHEN c.status IN ('approved','published') THEN 4 WHEN c.status = 'rejected' THEN 1.5 END)::float AS stars,
            (c.user_rating IS NOT NULL OR m.user_rating IS NOT NULL) AS explicit
       FROM moments m FULL OUTER JOIN clips c ON c.moment_id = m.id
      WHERE COALESCE(c.user_rating, m.user_rating) IS NOT NULL OR c.status IN ('approved','published','rejected')
      ORDER BY COALESCE(c.updated_at, m.created_at) DESC LIMIT 500`,
  );
  const stars: Record<string, number[]> = {};
  for (const r of rated) (stars[r.category || 'other'] ||= []).push(Number(r.stars));
  const categoryStars = Object.fromEntries(
    Object.entries(stars).map(([k, v]) => [k, { avgStars: v.reduce((a, b) => a + b, 0) / v.length, n: v.length }]),
  );
  const explicit = rated.filter((r) => r.explicit).sort((a, b) => b.stars - a.stars);
  const ratedExamples = [...explicit.filter((r) => r.stars >= 4).slice(0, 4), ...explicit.filter((r) => r.stars <= 2).slice(-4)]
    .map((r) => ({ title: r.title, stars: Number(r.stars) }));

  const value: LearningProfile = {
    categoryStars,
    ratedExamples,
    totalReviewed: rows.length,
    categoryApproval,
    approvedExamples: rows.filter((r) => r.status !== 'rejected').slice(0, 10).map((r) => r.title),
    rejectedExamples: rows.filter((r) => r.status === 'rejected').slice(0, 10).map((r) => ({ title: r.title, reason: r.reject_reason || undefined })),
    topPerformers: perf.slice(0, 8).map((p) => ({ title: p.title, views: Number(p.views), category: p.category || undefined })),
    categoryPerformance: Object.fromEntries(Object.entries(catViews).map(([k, v]) => [k, Math.round(v.reduce((a, b) => a + b, 0) / v.length)])),
  };
  cache = { at: Date.now(), value };
  return value;
}

/** Forget the cached profile (after the owner rates or reviews something). Other processes refresh within 10 min. */
export function invalidateLearningProfile() {
  cache = null;
}
