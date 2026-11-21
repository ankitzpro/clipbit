/** Intro / outro bumper files, stored in DATA_DIR/branding (e.g. D:\\clipforge-data\\branding). */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import type { AppSettings } from '../../settings.js';

export type BrandSlot = 'intro' | 'outro';
export const brandingDir = () => path.join(config.dataDir, 'branding');

/** Absolute path of the slot's file if it is enabled (globally or per clip) and exists. */
export function brandingFile(settings: AppSettings, slot: BrandSlot, clipOverride?: boolean): string | null {
  const b = settings.branding?.[slot];
  const enabled = clipOverride ?? b?.enabled;
  if (!enabled || !b?.file) return null;
  const file = path.join(brandingDir(), path.basename(b.file));
  return fs.existsSync(file) ? file : null;
}
