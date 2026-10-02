/** Server-only bridge to the existing Netlify Google connection. Credentials
 * never enter the core, model context, artifacts or diagnostics. Every request
 * re-reads the connection strongly; refreshing uses an ETag precondition so a
 * newly connected account or disconnect cannot be overwritten by an old job.
 */
import { HttpError } from './errors.mjs';

export const GOOGLE_OAUTH_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_OAUTH_STORE = 'quantus-google-oauth';
export const GOOGLE_OAUTH_KEY = 'tokens';
const MAX_BYTES = 64 * 1024;
const fail = (code, status = 503) => { throw new HttpError(status, `google_oauth_${code}`); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const secret = v => typeof v === 'string' && v.length > 0 && v.length <= 16384 && !/\s/.test(v);
const readScopes = new Set(['https://mail.google.com/', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.modify']);
const hasMailScope = v => typeof v === 'string' && v.split(/\s+/).some(s => readScopes.has(s));

export function createGoogleOAuthTokenSource({ store, clientId, clientSecret, now = Date.now,
  fetchImpl = globalThis.fetch, timeoutMs = 15000, mailAccessRequired = true } = {}) {
  if (typeof store?.getWithMetadata !== 'function' || typeof store?.set !== 'function'
    || !secret(clientId) || !secret(clientSecret) || typeof now !== 'function' || typeof fetchImpl !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20000 || typeof mailAccessRequired !== 'boolean') fail('configuration_invalid');
  const clock = () => { const n = now(); if (!Number.isSafeInteger(n) || n <= 0) fail('clock_invalid'); return n; };
  return Object.freeze({
    async get({ signal, forceRefresh = false } = {}) {
      if (typeof forceRefresh !== 'boolean') fail('configuration_invalid');
      if (signal?.aborted) fail('interrupted', 409);
      const abort = new AbortController();
      let rejectStop, reader;
      const stopped = new Promise((_, reject) => { rejectStop = reject; });
      const stop = (code, status) => {
        rejectStop(new HttpError(status, `google_oauth_${code}`)); abort.abort();
        if (reader) void reader.cancel().catch(() => {});
      };
      const interrupt = () => stop('interrupted', 409);
      signal?.addEventListener('abort', interrupt, { once: true });
      const timer = setTimeout(() => stop('timeout', 504), timeoutMs);
      const active = () => { if (abort.signal.aborted || signal?.aborted) fail('interrupted', 409); };
      async function load() {
        active();
        let snapshot;
        try { snapshot = await store.getWithMetadata(GOOGLE_OAUTH_KEY, { type: 'json', consistency: 'strong' }); }
        catch { fail('store_unavailable'); }
        active();
        if (snapshot === null) fail('not_connected');
        if (!object(snapshot?.data) || typeof snapshot.etag !== 'string' || !snapshot.etag
          || snapshot.etag.length > 1024 || /[\r\n]/.test(snapshot.etag)
          || Buffer.byteLength(JSON.stringify(snapshot.data)) > MAX_BYTES) fail('stored_connection_invalid');
        if (mailAccessRequired && !hasMailScope(snapshot.data.scope)) fail('mail_scope_missing', 403);
        return snapshot;
      }
      try {
        return await Promise.race([stopped, (async () => {
          const original = await load(), credentials = original.data;
          const startedAt = clock();
          if (!forceRefresh && secret(credentials.access_token) && Number.isSafeInteger(credentials.expiry) && credentials.expiry > startedAt + 60000)
            return { token: credentials.access_token };
          if (!secret(credentials.refresh_token)) fail('refresh_unavailable');
          active();
          let response;
          try {
            response = await fetchImpl(GOOGLE_OAUTH_URL, { method: 'POST', redirect: 'error', signal: abort.signal,
              headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
              body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: credentials.refresh_token,
                client_id: clientId, client_secret: clientSecret }).toString() });
          } catch { fail('refresh_failed'); }
          active();
          if (response?.status !== 200) {
            if (response?.body?.cancel) void response.body.cancel().catch(() => {});
            fail('refresh_rejected');
          }
          if (!response.body?.getReader) fail('refresh_response_invalid');
          const length = response.headers?.get('content-length');
          if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) {
            void response.body.cancel().catch(() => {}); fail('refresh_response_invalid');
          }
          reader = response.body.getReader();
          const chunks = []; let size = 0;
          try {
            for (;;) {
              const chunk = await reader.read(); active();
              if (chunk.done) break;
              size += chunk.value.byteLength;
              if (size > MAX_BYTES) { void reader.cancel().catch(() => {}); fail('refresh_response_invalid'); }
              chunks.push(Buffer.from(chunk.value));
            }
          } finally { reader.releaseLock(); reader = null; }
          let value;
          try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
          catch { fail('refresh_response_invalid'); }
          if (!object(value) || !secret(value.access_token) || value.token_type !== 'Bearer'
            || !Number.isSafeInteger(value.expires_in) || value.expires_in <= 60 || value.expires_in > 86400
            || (value.refresh_token !== undefined && !secret(value.refresh_token))) fail('refresh_response_invalid');
          const scope = value.scope === undefined ? credentials.scope : value.scope;
          if (mailAccessRequired && !hasMailScope(scope)) fail('mail_scope_missing', 403);
          // Base expiry on request start, not a possibly very late response.
          const expiry = startedAt + value.expires_in * 1000;
          if (!Number.isSafeInteger(expiry) || expiry <= clock() + 60000) fail('refresh_already_expired');
          const updated = { ...credentials, access_token: value.access_token, expiry,
            refresh_token: value.refresh_token ?? credentials.refresh_token, scope };
          active();
          let written;
          // The pinned Blobs SDK's setJSON spreads the condition into the
          // wrong client level. set(string, {onlyIfMatch}) sends If-Match.
          // Keep this covered through the actual SDK HTTP path, not a stub.
          try { written = await store.set(GOOGLE_OAUTH_KEY, JSON.stringify(updated), { onlyIfMatch: original.etag }); }
          catch { fail('refresh_write_unknown'); }
          active();
          if (written?.modified !== true || typeof written.etag !== 'string' || !written.etag) fail('connection_changed');
          const confirmed = await load();
          if (confirmed.etag !== written.etag || JSON.stringify(confirmed.data) !== JSON.stringify(updated)) fail('refresh_readback_failed');
          if (confirmed.data.expiry <= clock() + 60000) fail('refresh_already_expired');
          return { token: confirmed.data.access_token };
        })()]);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        fail('request_failed');
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', interrupt); }
    },
  });
}

/** Unlike Netlify Functions, Cloud Run has no ambient Blob credentials. Missing
 * explicit site/client configuration stays unavailable; no other site/account
 * or service-account Gmail impersonation is guessed as a fallback.
 */
export async function createNetlifyGoogleTokenSource({ envRead = key => process.env[key], now = Date.now,
  fetchImpl = globalThis.fetch, loadBlobs = () => import('@netlify/blobs') } = {}) {
  const siteID = envRead('QUANTUS_V4_GOOGLE_NETLIFY_SITE_ID'), token = envRead('QUANTUS_V4_GOOGLE_NETLIFY_TOKEN');
  const clientId = envRead('QUANTUS_V4_GOOGLE_CLIENT_ID'), clientSecret = envRead('QUANTUS_V4_GOOGLE_CLIENT_SECRET');
  if (typeof siteID !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(siteID) || !secret(token) || !secret(clientId) || !secret(clientSecret))
    return { available: false, reason: 'google_oauth_not_configured' };
  try {
    const blobs = await loadBlobs();
    const store = blobs.getStore({ name: GOOGLE_OAUTH_STORE, siteID, token, consistency: 'strong', apiURL: 'https://api.netlify.com' });
    const source = createGoogleOAuthTokenSource({ store, clientId, clientSecret, now, fetchImpl });
    return { available: true, get: source.get };
  } catch { return { available: false, reason: 'google_oauth_store_unavailable' }; }
}
