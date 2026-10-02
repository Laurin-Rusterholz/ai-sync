import * as E1 from '../../netlify/lib/quantus-v3-runtime-state.mjs';
import * as IDEM from '../../netlify/lib/quantus-v3-idempotency.mjs';
import * as F from '../quantus-v3-runtime-cas-harness.mjs';
import { createIntegrationCorePort } from '../../runtime/quantus-v3/src/integration-ports.mjs';
import { createLeadershipJournal } from '../../runtime/quantus-v3/src/leadership-journal.mjs';
import { artifactFixture } from './quantus-v4-artifact-fixture.mjs';
export const T = Date.parse('2026-10-02T07:01:00Z');
export const RUN = 'quantus:2026-10-02:process09:4.0';

export async function setup(initialData = F.baseCore(), { initialNow = T, runKey = RUN } = {}) {
  const store = F.createCasStore(initialData);
  const acquired = F.casMutate(store, d => E1.acquireLease(d, { holder: 'worker-a', scope: 'quantus:mainrun', now: initialNow }));
  const scope = { holder: 'worker-a', scope: 'quantus:mainrun', fence: acquired.result.fence };
  F.casMutate(store, d => E1.startRunSection(d, { runKey, sectionId: 'section-1', kind: 'http', now: initialNow, verifiedScope: scope }));
  let now = initialNow, beforeMutation = null, reads = 0, beforeRead = null;
  const port = await createIntegrationCorePort({ tenantId: 'quantus', principalId: 'worker-a', loadModules: async () => ({
    idem: IDEM,
    admin: {
      async readAppDataDocument() { reads++; if (beforeRead) beforeRead(reads); return { data: store.read().text, etag: 'fixture' }; },
      async mutateAppData(_, mutate) {
        return F.casMutate(store, mutate, { onAttempt(attempt) { if (beforeMutation) beforeMutation(attempt); } });
      },
    },
  }) });
  const clock = { now: () => now };
  const artifacts = artifactFixture({ maxPayloadBytes: 3 * 1024 * 1024 });
  const make = () => createLeadershipJournal({ core: port.impl, clock, runKey, verifiedScope: scope, artifacts: artifacts.store });
  return { store, core: port.impl, clock, scope, artifacts, make, journal: make(),
    setNow: v => { now = v; }, onMutation: fn => { beforeMutation = fn; }, onRead: fn => { beforeRead = fn; }, get reads() { return reads; } };
}
