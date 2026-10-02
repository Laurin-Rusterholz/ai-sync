/** One durable source step per call. Pages are immutable evidence, each mail
 * is independently registered before its page index advances, and only the
 * final history page promotes the source watermark. `done` means acquisition
 * finished, not that the mail was understood, acted on or a day may close.
 */
import { createHash } from 'node:crypto';
import { HttpError } from './errors.mjs';
import { createGmailMessageRegistry } from './gmail-message-registry.mjs';
import { GMAIL_V4_QUERY } from './gmail-v4-reader.mjs';
import { validArtifactReference } from './work-artifact-store.mjs';
import { assertActiveRuntimeCapacity } from './runtime-payload.mjs';
import { assertLeadership, readRuntime } from '../../../netlify/lib/quantus-v3-runtime-state.mjs';
import { parseSlotRunKey } from '../../../netlify/lib/quantus-v3-runtime-plan.mjs';

const hash = v => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const fail = code => { throw new HttpError(409, `gmail_sync_${code}`); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fields = (v, names) => object(v) && Object.keys(v).sort().join(',') === names.split(',').sort().join(',');
const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(v);
const history = v => typeof v === 'string' && /^[1-9][0-9]{0,29}$/.test(v);
const token = v => v === null || (typeof v === 'string' && v.length > 0 && v.length <= 4096 && !/[\x00-\x20\x7f]/.test(v));
const ref = v => v === null || validArtifactReference(v);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const PAGE_BYTES = 3 * 1024 * 1024;

export function createGmailSourceSync({ reader, core, clock, artifacts, tenant, account, sourceId,
  runKey, sectionId, verifiedScope, signal } = {}) {
  if (!reader?.profile || !reader?.listPage || !reader?.historyPage || !reader?.getMessage
    || reader.account !== account || reader.query !== GMAIL_V4_QUERY || !core?.read || !core?.mutate || !clock?.now
    || parseSlotRunKey(runKey).tenant !== tenant || verifiedScope?.scope !== `${tenant}:mainrun`) fail('configuration_invalid');
  const identity = { tenant, account, sourceId }, sourceKey = hash(identity);
  const registry = createGmailMessageRegistry({ core, clock, artifacts, tenant, account, sourceId, runKey, sectionId, verifiedScope, signal });
  function check(data) {
    if (signal?.aborted) fail('interrupted');
    assertLeadership(data, verifiedScope, clock.now());
    const runtime = readRuntime(data), run = runtime.runsByKey[runKey], section = run?.sections?.[sectionId];
    if (run?.phase !== 'active' || run.currentSectionId !== sectionId || section?.closed !== false
      || section.holder !== verifiedScope.holder || section.fence !== verifiedScope.fence) fail('section_mismatch');
    return runtime;
  }
  function validate(s) {
    if (!fields(s, 'schema,identity,query,runKey,revision,phase,historyId,anchor,pageToken,page,index,count,lastPage,gaps,recoveries,completedAtMs,seenPages,seenHistoryId')
      || s.schema !== 1 || !equal(s.identity, identity) || s.query !== GMAIL_V4_QUERY
      || typeof s.runKey !== 'string' || parseSlotRunKey(s.runKey).tenant !== tenant
      || !Number.isSafeInteger(s.revision) || s.revision < 1
      || !['profile', 'list', 'history', 'message', 'done'].includes(s.phase)
      || !(s.historyId === null || history(s.historyId)) || !(s.anchor === null || history(s.anchor))
      || !token(s.pageToken) || !ref(s.page) || !ref(s.lastPage)
      || !Number.isSafeInteger(s.index) || s.index < 0 || !Number.isSafeInteger(s.count) || s.count < s.index || s.count > 10000
      || !Number.isSafeInteger(s.recoveries) || s.recoveries < 0 || !object(s.gaps) || !object(s.seenPages)
      || !(s.seenHistoryId === null || history(s.seenHistoryId))
      || !(s.completedAtMs === null || (Number.isSafeInteger(s.completedAtMs) && s.completedAtMs > 0))) fail('state_invalid');
    if ((s.phase === 'message') !== (s.page !== null) || (s.phase !== 'message' && (s.index !== 0 || s.count !== 0))
      || (['list', 'history', 'message', 'done'].includes(s.phase) && !history(s.anchor))
      || (s.phase === 'done' && (!history(s.historyId) || !s.lastPage || s.completedAtMs === null
        || s.seenHistoryId !== s.historyId || BigInt(s.anchor) > BigInt(s.historyId)))) fail('state_invalid');
    for (const [key, gap] of Object.entries(s.gaps)) {
      if (!fields(gap, 'messageId,reason,page,contentHash') || !id(gap.messageId) || key !== hash(gap.messageId)
        || !['message_missing', 'message_partial'].includes(gap.reason) || !validArtifactReference(gap.page)
        || !(gap.contentHash === null || /^[a-f0-9]{64}$/.test(gap.contentHash))) fail('state_invalid');
    }
    if (Object.entries(s.seenPages).some(([k, v]) => !/^[a-f0-9]{64}$/.test(k) || v !== true)) fail('state_invalid');
    return s;
  }
  function state(data) {
    const runtime = check(data), root = runtime.gmailSync, marker = runtime.gmailSyncInitialized;
    if (root === undefined && marker === undefined) return null;
    if (marker !== true || !fields(root, 'schema,sources,count') || root.schema !== 1 || !object(root.sources)
      || root.count !== Object.keys(root.sources).length) fail('area_invalid');
    const s = root.sources[sourceKey];
    return s === undefined ? null : validate(s);
  }
  async function snapshot() { const data = (await core.read())?.data; check(data); return data; }
  async function readArtifact(reference) {
    if (!validArtifactReference(reference)) fail('page_reference_invalid');
    await snapshot();
    const text = await artifacts.read(reference, { signal });
    await snapshot();
    if (typeof text !== 'string' || Buffer.byteLength(text) !== reference.bytes || hash(text) !== reference.hash) fail('page_readback_invalid');
    try { return JSON.parse(text); } catch { fail('page_readback_invalid'); }
  }
  async function savePage(value) {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > PAGE_BYTES) fail('page_capacity');
    await snapshot();
    const reference = await artifacts.put({ text, hash: hash(text), signal });
    if (!equal(await readArtifact(reference), value)) fail('page_readback_invalid');
    return reference;
  }
  function pageInfo(page, s) {
    if (!fields(page, 'schema,identity,mode,anchor,pageToken,previous,response') || page.schema !== 'quantus-gmail-page/1'
      || !equal(page.identity, identity) || !['list', 'history'].includes(page.mode)
      || page.anchor !== s.anchor || page.pageToken !== s.pageToken || !equal(page.previous, s.lastPage)
      || !object(page.response) || !token(page.response.nextPageToken)) fail('page_invalid');
    let ids;
    if (page.mode === 'list') ids = page.response.ids;
    else {
      if (page.response.resetRequired !== false || !history(page.response.historyId)
        || BigInt(page.response.historyId) < BigInt(s.anchor) || !Array.isArray(page.response.changes)) fail('page_invalid');
      ids = page.response.changes.map(c => c?.id);
    }
    if (!Array.isArray(ids) || ids.length > 10000 || !ids.every(id) || new Set(ids).size !== ids.length
      || (page.response.nextPageToken !== null && page.response.nextPageToken === page.pageToken)) fail('page_invalid');
    return ids;
  }
  async function commit(before, next, registered = null) {
    next = validate({ ...next, revision: (before?.revision || 0) + 1 });
    const key = 'v4-gmail-sync-' + hash([identity, before, next]);
    await snapshot();
    const receipt = await core.mutate({ commandKey: key, requestId: key, now: clock.now(), mutate(data) {
      const runtime = check(data);
        if (!equal(state(data), before)) fail('concurrent_state_change');
        if (registered) {
          const stored = runtime.gmailRegistry?.sources?.[sourceKey]?.records?.[hash([account, registered.messageId])];
          if (!equal(stored, registered)) fail('registration_changed');
        }
      if (!runtime.gmailSync) {
        runtime.gmailSync = { schema: 1, sources: {}, count: 0 };
        runtime.gmailSyncInitialized = true;
      }
      const root = runtime.gmailSync;
      if (!root.sources[sourceKey]) root.count++;
      root.sources[sourceKey] = structuredClone(next);
      assertActiveRuntimeCapacity(data);
      return { data, result: { revision: next.revision } };
    } });
    if (receipt.result?.revision !== next.revision || !equal(state(await snapshot()), next)) fail('checkpoint_unconfirmed');
    return { done: next.phase === 'done', sourceKey, phase: next.phase, revision: next.revision,
      historyId: next.historyId, partial: Object.keys(next.gaps).length > 0, proof: next.lastPage };
  }
  return Object.freeze({
    async next() {
      const s = state(await snapshot());
      if (!s) return commit(null, { schema: 1, identity, query: GMAIL_V4_QUERY, runKey, revision: 1,
        phase: 'profile', historyId: null, anchor: null, pageToken: null, page: null, index: 0, count: 0,
        lastPage: null, gaps: {}, recoveries: 0, completedAtMs: null, seenPages: {}, seenHistoryId: null });
      if (s.runKey !== runKey) {
        // An unfinished acquisition survives a day/section change. A finished
        // one starts incremental sync from the last fully committed history.
        return commit(s, { ...s, runKey, completedAtMs: null,
          ...(s.phase === 'done' ? { phase: 'history', anchor: s.historyId, pageToken: null, seenPages: {}, seenHistoryId: s.historyId } : {}) });
      }
      if (s.phase === 'done') {
        // Do not turn an old completion row into proof if its final page is lost.
        const page = await readArtifact(s.lastPage);
        if (!fields(page, 'schema,identity,mode,anchor,pageToken,previous,response') || page.schema !== 'quantus-gmail-page/1'
          || !equal(page.identity, identity) || page.mode !== 'history' || page.anchor !== s.anchor
          || page.response?.resetRequired !== false || page.response.nextPageToken !== null
          || page.response.historyId !== s.historyId) fail('completion_unconfirmed');
        if (!equal(state(await snapshot()), s)) fail('completion_changed');
        return { done: true, sourceKey, phase: 'done', revision: s.revision, historyId: s.historyId,
          partial: Object.keys(s.gaps).length > 0, proof: s.lastPage };
      }
      if (s.phase === 'profile') {
        const profile = await reader.profile({ signal });
        if (profile.account !== account || !history(profile.historyId)) fail('profile_invalid');
        if (s.historyId !== null && BigInt(profile.historyId) < BigInt(s.historyId)) fail('history_regressed');
        return commit(s, { ...s, anchor: profile.historyId, phase: 'list', pageToken: null, seenHistoryId: profile.historyId });
      }
      if (s.phase === 'list' || s.phase === 'history') {
        const pageKey = hash([s.phase, s.anchor, s.pageToken]);
        if (s.seenPages[pageKey]) fail('page_cycle');
        const response = s.phase === 'list' ? await reader.listPage({ pageToken: s.pageToken, signal })
          : await reader.historyPage({ startHistoryId: s.anchor, pageToken: s.pageToken, signal });
        if (s.phase === 'history' && response.resetRequired === true) {
          // Preserve registry, previous page evidence and all existing gaps.
          // No expired watermark can be promoted to a successful empty sync.
          return commit(s, { ...s, phase: 'profile', anchor: null, pageToken: null, recoveries: s.recoveries + 1, seenPages: {} });
        }
        const page = { schema: 'quantus-gmail-page/1', identity, mode: s.phase, anchor: s.anchor,
          pageToken: s.pageToken, previous: s.lastPage, response };
        const ids = pageInfo(page, s), reference = await savePage(page);
        if (s.phase === 'history' && s.seenHistoryId !== null && BigInt(response.historyId) < BigInt(s.seenHistoryId)) fail('history_regressed');
        return commit(s, { ...s, phase: 'message', page: reference, index: 0, count: ids.length,
          seenPages: { ...s.seenPages, [pageKey]: true }, seenHistoryId: s.phase === 'history' ? response.historyId : s.seenHistoryId });
      }
      const page = await readArtifact(s.page), ids = pageInfo(page, s);
      if (ids.length !== s.count) fail('page_invalid');
      if (s.index < ids.length) {
        const messageId = ids[s.index], mail = await reader.getMessage({ messageId, signal });
        const gaps = { ...s.gaps }, key = hash(messageId);
        let registered = null;
        if (mail.missing === true) {
          if (mail.id !== messageId) fail('message_invalid');
          gaps[key] = { messageId, reason: 'message_missing', page: s.page, contentHash: null };
        } else {
          const saved = await registry.register({ messageId, text: JSON.stringify(mail) });
          if (saved.confirmed !== true) fail('registration_unconfirmed');
          registered = saved.record;
          if (saved.record.partial) gaps[key] = { messageId, reason: 'message_partial', page: s.page, contentHash: saved.record.contentHash };
          else delete gaps[key];
        }
        return commit(s, { ...s, index: s.index + 1, gaps }, registered);
      }
      const nextToken = page.response.nextPageToken;
      const next = { ...s, page: null, index: 0, count: 0, lastPage: s.page, pageToken: nextToken };
      if (nextToken !== null) next.phase = page.mode;
      else if (page.mode === 'list') next.phase = 'history'; // catch up changes made during the full scan
      else {
        next.phase = 'done'; next.historyId = page.response.historyId; next.completedAtMs = clock.now();
      }
      return commit(s, next);
    },
  });
}
