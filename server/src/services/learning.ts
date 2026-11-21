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

  const value: LearningProfile = {
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
