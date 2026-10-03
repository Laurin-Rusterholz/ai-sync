/** Google Cloud workload identity for a fixed reviewed recipient.
 * Uses the attached service account, never a downloaded key or an OAuth access
 * token. Construction has no network effects. No retry or credential fallback.
 * https://docs.cloud.google.com/run/docs/authenticating/service-to-service
 */
import { HttpError } from './errors.mjs';
import { MAX_TOKEN_BYTES, verifyGoogleIdToken } from './oidc.mjs';

const METADATA_IDENTITY = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';
const failure = () => new HttpError(503, 'google_id_token_unavailable');

export function createGoogleIdTokenSource({ audience, serviceAccount, clock, jwks,
  fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  let target;
  try { target = new URL(audience); } catch { throw new TypeError('google_id_token_configuration_invalid'); }
  if (target.protocol !== 'https:' || target.username || target.password || target.hash || target.search
    || typeof serviceAccount !== 'string' || !/^[a-zA-Z0-9._-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(serviceAccount)
    || !clock?.now || !jwks?.getKeys || typeof fetchImpl !== 'function'
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
    throw new TypeError('google_id_token_configuration_invalid');
  const url = new URL(METADATA_IDENTITY);
  url.searchParams.set('audience', audience);
  url.searchParams.set('format', 'full');
  return Object.freeze({
    async get({ audience: requestedAudience, signal } = {}) {
      if (requestedAudience !== audience) throw failure();
      const controller = new AbortController();
      let reader, rejectDeadline;
      const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
      const abort = () => {
        controller.abort();
        void reader?.cancel().catch(() => {});
        rejectDeadline(failure());
      };
      const timer = setTimeout(abort, timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const check = () => { if (controller.signal.aborted) throw failure(); };
      try {
        return await Promise.race([deadline, (async () => {
          check();
          const response = await fetchImpl(url.href, { method: 'GET', redirect: 'error',
            headers: { 'Metadata-Flavor': 'Google' }, signal: controller.signal });
          check();
          if (response.status !== 200 || response.headers.get('metadata-flavor') !== 'Google') {
            void response.body?.cancel().catch(() => {});
            throw failure();
          }
          reader = response.body?.getReader();
          if (!reader) throw failure();
          const chunks = []; let size = 0;
          for (;;) {
            const part = await reader.read(); check();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > MAX_TOKEN_BYTES) { void reader.cancel().catch(() => {}); throw failure(); }
            chunks.push(Buffer.from(part.value));
          }
          const token = Buffer.concat(chunks).toString('utf8');
          const keys = await jwks.getKeys(); check();
          verifyGoogleIdToken(token, { audience, allowedServiceAccounts: [serviceAccount], jwks: keys, now: clock.now() });
          return token;
        })()]);
      } catch { throw failure(); }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    },
  });
}
