/**
 * YouTube Data API v3 + OAuth 2.0.
 * Tokens are stored AES-256-GCM encrypted (APP_SECRET). Refreshed tokens are persisted automatically.
 */
import { google } from 'googleapis';
import { config, youtubeRedirectUri } from '../../config.js';
import { one, q } from '../../db/pool.js';
import { decrypt, encrypt } from '../../lib/crypto.js';

export const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
];

export const youtubeConfigured = () => !!(config.google.clientId && config.google.clientSecret);

export function oauthClient() {
  return new google.auth.OAuth2(config.google.clientId, config.google.clientSecret, youtubeRedirectUri());
}

export function authUrl(state: string) {
  return oauthClient().generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES, state, include_granted_scopes: true });
}

export async function handleCallback(code: string) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  const yt = google.youtube({ version: 'v3', auth: client });
  const me = await yt.channels.list({ part: ['snippet'], mine: true });
  const ch = me.data.items?.[0];
  if (!ch?.id) throw new Error('This Google account has no YouTube channel');
  const existing = await one<{ tokens_enc: string }>(`SELECT tokens_enc FROM youtube_accounts WHERE channel_id = $1`, [ch.id]);
  // Google only returns a refresh_token on first consent; keep the old one if missing
  const merged = { ...(existing ? JSON.parse(decrypt(existing.tokens_enc)) : {}), ...tokens };
  await q(
    `INSERT INTO youtube_accounts (channel_id, channel_title, thumbnail, tokens_enc) VALUES ($1,$2,$3,$4)
     ON CONFLICT (channel_id) DO UPDATE SET channel_title = EXCLUDED.channel_title, thumbnail = EXCLUDED.thumbnail, tokens_enc = EXCLUDED.tokens_enc, updated_at = now()`,
    [ch.id, ch.snippet?.title || '', ch.snippet?.thumbnails?.default?.url || '', encrypt(JSON.stringify(merged))],
  );
  return { channelId: ch.id, title: ch.snippet?.title };
}

export async function getAccount(id?: string) {
  return id
    ? one<any>(`SELECT * FROM youtube_accounts WHERE id = $1`, [id])
    : one<any>(`SELECT * FROM youtube_accounts ORDER BY updated_at DESC LIMIT 1`);
}

export async function authedClient(accountId?: string) {
  const acct = await getAccount(accountId);
  if (!acct) throw new Error('No YouTube channel connected');
  const client = oauthClient();
  const tokens = JSON.parse(decrypt(acct.tokens_enc));
  client.setCredentials(tokens);
  client.on('tokens', (t: any) => {
    const merged = { ...tokens, ...t };
    void q(`UPDATE youtube_accounts SET tokens_enc = $2, updated_at = now() WHERE id = $1`, [acct.id, encrypt(JSON.stringify(merged))]);
  });
  return { client, account: acct };
}

export async function disconnect(accountId: string) {
  const acct = await getAccount(accountId);
  if (!acct) return;
  try {
    const tokens = JSON.parse(decrypt(acct.tokens_enc));
    if (tokens.refresh_token || tokens.access_token) await oauthClient().revokeToken(tokens.refresh_token || tokens.access_token);
  } catch {
    /* ignore revoke failures */
  }
  await q(`DELETE FROM youtube_accounts WHERE id = $1`, [accountId]);
}
