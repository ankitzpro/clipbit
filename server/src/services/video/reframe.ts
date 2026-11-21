/**
 * 16:9 -> 9:16 reframing.
 *  smart  : a virtual camera follows the on-screen action (motion saliency) with smoothing and a dead-zone
 *  blur   : full frame fitted to the width over a blurred, zoomed copy of itself (nothing is cropped away)
 *  center : static center crop
 *  split  : streamer facecam on top, gameplay underneath (needs a facecam rectangle)
 */
import fs from 'node:fs/promises';
import { readGrayFrames } from './media.js';

export const OUT_W = 1080;
export const OUT_H = 1920;

export type ReframeMode = 'smart' | 'blur' | 'center' | 'split';
export interface FacecamRect { x: number; y: number; w: number; h: number } // normalized 0..1

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

/** Column-wise saliency (mostly motion, some edges, mild center bias) -> crop center per analysis frame. */
export function computeCropTrack(frames: Uint8Array[], w: number, h: number, cropWA: number): number[] {
  const centers: number[] = [];
  const ema = new Float64Array(w);
  const mid = (w - 1) / 2;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const prev = frames[Math.max(0, i - 1)];
    const col = new Float64Array(w);
    let motionSum = 0;
    // ignore the outer 6% rows (HUD bars, letterboxing) to reduce static-overlay bias
    const y0 = Math.floor(h * 0.06);
    const y1 = Math.ceil(h * 0.94);
    for (let y = y0; y < y1; y++) {
      const row = y * w;
      for (let x = 1; x < w - 1; x++) {
        const p = row + x;
        const motion = Math.abs(f[p] - prev[p]);
        const edge = Math.abs(f[p + 1] - f[p - 1]);
        motionSum += motion;
        col[x] += motion + edge * 0.15;
      }
    }
    for (let x = 0; x < w; x++) {
      const bias = 1 - 0.4 * Math.abs(x - mid) / mid;
      ema[x] = i === 0 ? col[x] * bias : ema[x] * 0.55 + col[x] * bias * 0.45;
    }
    // best window of width cropWA
    const cw = Math.max(1, Math.round(cropWA));
    let sum = 0;
    for (let x = 0; x < cw && x < w; x++) sum += ema[x];
    let best = sum;
    let bestX = 0;
    for (let x = cw; x < w; x++) {
      sum += ema[x] - ema[x - cw];
      if (sum > best) {
        best = sum;
        bestX = x - cw + 1;
      }
    }
    // basically static frame (menu, pause, cut-scene hold): keep the previous framing
    const motionMean = motionSum / Math.max(1, (y1 - y0) * (w - 2));
    const center = i > 0 && motionMean < 0.8 ? centers[i - 1] : bestX + cw / 2;
    centers.push(center);
  }
  return centers;
}

/** Turn noisy per-frame targets into smooth camera motion sampled at `outFps`. */
export function smoothCamera(targets: number[], inFps: number, outFps: number, width: number, cropW: number): number[] {
  if (!targets.length) return [];
  // median filter (removes single-frame jumps)
  const med = targets.map((_, i) => {
    const win = targets.slice(Math.max(0, i - 2), i + 3).sort((a, b) => a - b);
    return win[Math.floor(win.length / 2)];
  });
  const duration = targets.length / inFps;
  const n = Math.ceil(duration * outFps);
  const deadZone = cropW * 0.18;
  const maxSpeed = width * 0.45; // px per second
  const minX = cropW / 2;
  const maxX = width - cropW / 2;
  let pos = Math.min(maxX, Math.max(minX, med[0]));
  let vel = 0;
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const t = k / outFps;
    const fi = Math.min(med.length - 1, t * inFps);
    const i0 = Math.floor(fi);
    const i1 = Math.min(med.length - 1, i0 + 1);
    const target = Math.min(maxX, Math.max(minX, med[i0] + (med[i1] - med[i0]) * (fi - i0)));
    const diff = target - pos;
    const desired = Math.abs(diff) > deadZone ? Math.sign(diff) * Math.min(maxSpeed, Math.abs(diff) * 2.2) : diff * 0.15;
    vel = vel * 0.8 + desired * 0.2; // ease in/out
    pos = Math.min(maxX, Math.max(minX, pos + vel / outFps));
    out.push(pos);
  }
  return out;
}

export interface ReframePlan {
  /** filter graph from [0:v] to [vr] (1080x1920) */
  graph: string;
  cmdFile?: string;
}

export async function planReframe(input: string, srcW: number, srcH: number, mode: ReframeMode, workDir: string, facecam?: FacecamRect | null): Promise<ReframePlan> {
  const srcAspect = srcW / srcH;
  const target = OUT_W / OUT_H;

  if (srcAspect <= target + 0.01) {
    // already vertical (or narrower): just fit/pad
    return { graph: `[0:v]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease,pad=${OUT_W}:${OUT_H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1[vr]` };
  }

  if (mode === 'split' && facecam && facecam.w > 0 && facecam.h > 0) {
    const topH = even(OUT_H * 0.36);
    const botH = OUT_H - topH;
    const fx = even(facecam.x * srcW), fy = even(facecam.y * srcH), fw = even(facecam.w * srcW), fh = even(facecam.h * srcH);
    const botW = even(Math.min(srcW, srcH * (OUT_W / botH)));
    return {
      graph:
        `[0:v]split=2[cam][game];` +
        `[cam]crop=${fw}:${fh}:${fx}:${fy},scale=${OUT_W}:${topH}:force_original_aspect_ratio=increase,crop=${OUT_W}:${topH}[top];` +
        `[game]crop=${botW}:ih:(iw-${botW})/2:0,scale=${OUT_W}:${botH}:force_original_aspect_ratio=increase,crop=${OUT_W}:${botH}[bot];` +
        `[top][bot]vstack=inputs=2,setsar=1[vr]`,
    };
  }

  if (mode === 'blur' || mode === 'split') {
    return {
      graph:
        `[0:v]split=2[bg][fg];` +
        `[bg]scale=${OUT_W / 4}:${OUT_H / 4}:force_original_aspect_ratio=increase,crop=${OUT_W / 4}:${OUT_H / 4},boxblur=10:2,eq=brightness=-0.1:saturation=1.2,scale=${OUT_W}:${OUT_H}[bgb];` +
        `[fg]scale=${OUT_W}:-2:flags=lanczos[fgs];` +
        `[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1[vr]`,
    };
  }

  const cropW = even(srcH * target);
  if (mode === 'center') {
    return { graph: `[0:v]crop=${cropW}:ih:(iw-${cropW})/2:0,scale=${OUT_W}:${OUT_H}:flags=lanczos,setsar=1[vr]` };
  }

  // smart
  const AW = 160;
  const AH = Math.max(2, Math.round(AW / srcAspect / 2) * 2);
  const inFps = 4;
  const g = await readGrayFrames(input, inFps, AW, AH);
  const scale = srcW / AW;
  const centersA = computeCropTrack(g.frames, AW, AH, cropW / scale);
  const outFps = 10;
  const path = smoothCamera(centersA.map((c) => c * scale), inFps, outFps, srcW, cropW);
  const xs = path.map((c) => Math.round(Math.min(srcW - cropW, Math.max(0, c - cropW / 2))));
  const x0 = xs[0] ?? Math.round((srcW - cropW) / 2);
  const cmdFile = `${workDir}/crop.cmd`;
  const lines: string[] = [];
  let last = -1;
  xs.forEach((x, k) => {
    if (x !== last) lines.push(`${(k / outFps).toFixed(2)} crop x ${x};`);
    last = x;
  });
  await fs.writeFile(cmdFile, lines.join('\n') + '\n');
  return {
    graph: `[0:v]sendcmd=f=crop.cmd,crop=w=${cropW}:h=ih:x=${x0}:y=0,scale=${OUT_W}:${OUT_H}:flags=lanczos,setsar=1[vr]`,
    cmdFile,
  };
}
