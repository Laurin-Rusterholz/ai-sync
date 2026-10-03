import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIWorkerPorts } from '../runtime/quantus-v3/src/openai-composition.mjs';
import { migrateCore } from '../netlify/lib/assistant-migration.mjs';
import { POLICY_TEMPLATE } from '../netlify/lib/assistant-schema.mjs';
import { createQuantusV3DomainAdapter, DOMAIN_PORT_VARS } from '../netlify/lib/quantus-v3-domain-adapter.mjs';
import { setup, T, RUN } from './fixtures/quantus-v4-leadership-fixture.mjs';
import * as F from './quantus-v3-e2-fixtures.mjs';
import { reserveCost } from '../netlify/lib/quantus-v3-runtime-state.mjs';
import { projectPage } from '../netlify/lib/quantus-v3-read-helpers.mjs';
import { applyCommand } from '../netlify/lib/assistant-core.mjs';
import { createGmailMessageRegistry } from '../runtime/quantus-v3/src/gmail-message-registry.mjs';
import { createGmailIntakeBinding } from '../runtime/quantus-v3/src/gmail-intake-binding.mjs';

const assistantPolicy = { ...POLICY_TEMPLATE, tenant: 'quantus', version: '4.0',
  requiredSources: [{ id: 'quantus-core', kind: 'quantus-core' }], noExternalSources: true };
// Synthetic in-process operator policy; never loaded into a real service.
const costPolicy = { schema: 'quantus-v3-cost-policy/1', version: 'test-only', currency: 'USD',
  approval: { approvedBy: 'synthetic-test', approvalRef: 'NOT-A-REAL-APPROVAL', approvedAtMs: T - 1000 },
  effectiveFromMs: T - 1000, effectiveUntilMs: T + 86400000,
  dayLimitMicros: 1000000, runLimitMicros: 1000000, callLimitMicros: 100000, unresolvedBlockMicros: 1000000,
  featureFlags: { providers: 'live' }, models: { 'openai:test-model': {
    inputMicrosPerMillionTokens: 1000, outputMicrosPerMillionTokens: 1000, maxCallMicros: 100000 } } };
async function build({ mode = 'live', providerFailure = false, compaction = false, large = false, gmail = false, acquire = false, reply = false, close = false, legacy = false } = {}) {
  const now = close ? Date.parse('2026-10-02T21:01:00Z') : T;
  const runKey = close ? 'quantus:2026-10-02:close23:4.0' : RUN;
  let initial = migrateCore({ entities: close ? { chatgptLeads: close === 'open'
    ? { l1: { id: 'l1', status: 'neu', assignee: 'chatgpt' } } : {} }
    : { tasks: { task1: { id: 'task1', status: 'todo', ...(large ? { notes: 'Large original '.repeat(large === 'long' ? 280000 : 65000) } : {}) } } } }, { now }).data;
  if (close) for (const slot of ['briefing04', 'process09', 'continue14']) {
    const r = applyCommand(initial, { type: 'ensureRunSlot', commandId: 'prior-' + slot, now,
      payload: { date: '2026-10-02', slot, receiptId: 'prior-' + slot } }, { policy: assistantPolicy, actor: { kind: 'system', id: 'fixture' } });
    assert.equal(r.ok, true); initial = r.data;
  }
  if (legacy) {
    initial.entities.chatgptLeads.legacy = { id: 'legacy', status: 'neu', title: 'Alter Auftrag', pendingQuestion: {
      text: 'Welcher Termin?', options: ['Heute', 'Morgen'], answer: 'Morgen', answeredAt: '2026-10-01T10:00:00Z' } };
    initial = migrateCore(initial, { now }).data;
  }
  const s = await setup(initial, { initialNow: now, runKey });
  const requests = [], tools = [], sourceRequests = [];
  const runPolicy = acquire ? { ...assistantPolicy, noExternalSources: false,
    requiredSources: [...assistantPolicy.requiredSources, { id: 'gmail-inbox', kind: 'mail' }] } : assistantPolicy;
  if (reply) {
    for (const [type, payload, actor] of [
      ['askQuestion', { questionId: 'q1', sourceType: 'task', sourceId: 'task1', text: 'Wie weiter?', options: ['Ja', 'Nein'] }, { kind: 'agent', id: 'agent' }],
      ['recordAnswer', { answerId: 'a1', questionId: 'q1', text: 'Bitte den bestehenden Auftrag ausführen.' }, { kind: 'user', id: 'owner' }],
    ]) s.store.forceWrite(data => {
      const result = applyCommand(data, { type, payload, commandId: 'fixture-' + type, now: now }, { policy: runPolicy, actor });
      assert.equal(result.ok, true); return result.data;
    });
  }
  if (gmail) {
    const source = { core: s.core, clock: s.clock, artifacts: s.artifacts.store, tenant: 'quantus',
      account: 'mail@example.test', sourceId: 'gmail-test', runKey: runKey, sectionId: 'section-1', verifiedScope: s.scope, policy: assistantPolicy };
    await createGmailMessageRegistry(source).register({ messageId: 'mail1', text: JSON.stringify({ missing: false,
      account: source.account, id: 'mail1', threadId: 'thread1', historyId: '100', internalDate: String(now),
      partial: gmail === 'partial', gaps: gmail === 'partial' ? [{ reason: 'attachment_unread' }] : [],
      parts: [{ text: 'Full source available to the actual model transport.'.repeat(gmail === 'large' ? 12000 : 1) }],
      original: { id: 'mail1', threadId: 'thread1', historyId: '100' } }) });
    await createGmailIntakeBinding(source).bind({ messageId: 'mail1' });
  }
  const env = { QUANTUS_V4_OPENAI_API_KEY: 'test-secret-not-real', QUANTUS_V4_OPENAI_MODEL: 'test-model',
    QUANTUS_V4_OPENAI_INPUT_MICROS_PER_MTOK: '1000', QUANTUS_V4_OPENAI_OUTPUT_MICROS_PER_MTOK: '1000',
    QUANTUS_V4_PROMPT_VERSION: '4.0.0', QUANTUS_V3_COST_POLICY_JSON: JSON.stringify(costPolicy),
    [DOMAIN_PORT_VARS.policyJson]: JSON.stringify(runPolicy) };
  if (acquire) Object.assign(env, { QUANTUS_V4_GMAIL_ACCOUNT: 'mail@example.test', QUANTUS_V4_GMAIL_SOURCE_ID: 'gmail-inbox' });
  if (compaction) env.QUANTUS_V4_OPENAI_COMPACT_THRESHOLD = '16000';
  const config = { ...F.configFor('worker', { QUANTUS_V3_RUNTIME_MODE: mode,
    QUANTUS_V3_REQUIRED_SOURCES: '["quantus-core"]', QUANTUS_V3_ALLOW_EXTERNAL_EFFECTS: 'true', QUANTUS_V3_ACTIVATION_GATES: F.allGatesPassed() }),
    tenant: 'quantus', policyVersion: '4.0', leaseScope: 'quantus:mainrun', c2BaseUrl: 'https://quantus.invalid',
    toolsEnabled: { quantus_context: true, quantus_read: true, quantus_command: true, quantus_run_status: true } };
  const args = { runKey: runKey, sectionId: 'section-1', verifiedScope: s.scope, cursor: { position: 0 } };
  const make = overrides => createOpenAIWorkerPorts({ config, corePort: { available: true, impl: s.core }, clockPort: s.clock,
    envRead: name => env[name], artifactStore: s.artifacts.store,
    gmailTokenSource: { available: true, async get() { return { token: 'synthetic-gmail-token' }; } },
    gmailFetch: async url => {
      assert.equal(requests.length, 0, 'source acquisition precedes the first model request');
      url = new URL(url); sourceRequests.push(url.pathname);
      if (url.pathname.endsWith('/profile')) return Response.json({ emailAddress: 'mail@example.test', historyId: '100' });
      if (url.pathname.endsWith('/messages')) return Response.json({ messages: [{ id: 'mail1', threadId: 'thread1' }] });
      if (url.pathname.endsWith('/history')) return Response.json({ historyId: '200' });
      const text = 'Automatically acquired mail reaches the model.';
      return Response.json({ id: 'mail1', threadId: 'thread1', historyId: '150', internalDate: String(now),
        payload: { mimeType: 'text/plain', headers: [], body: { size: Buffer.byteLength(text), data: Buffer.from(text).toString('base64url') } } });
    },
    jobTokenIssuer: { available: true, async mint({ jobId, tenant }) {
      assert.equal(jobId, 'run_2026-10-02'); assert.equal(tenant, 'quantus'); return 'test-job-token';
    } },
    c2Transport: { async send(request) {
      tools.push(request);
      const params = request.searchParams, data = s.store.snapshot();
      const domain = createQuantusV3DomainAdapter({ policyVersion: '4.0', tenantId: 'quantus', mode: 'enforce',
        now: () => now, ports: { policy: runPolicy, ownerId: 'test-owner' } });
      const revision = data.automation.dataRevision;
      let afterId = null;
      if (params.cursor) {
        const decoded = JSON.parse(params.cursor);
        assert.equal(decoded.revision, revision, 'no journal/cost write may occur between context pages');
        afterId = decoded.afterId;
      }
      const page = domain.listPage(data, { query: params.query, scopeId: params.scopeId, pageSize: large ? Number(params.pageSize) : 1,
        afterId, principal: { role: 'lead_agent', jobId: 'run_2026-10-02' } });
      const projection = projectPage(params.query, page.items);
      assert.equal(projection.ok, true); assert.equal(projection.usable, true);
      return { status: 200, body: { ok: true, requestId: `read-${tools.length}`, serverNow: new Date(now).toISOString(),
        dataRevision: revision, query: params.query, scopeId: params.scopeId, items: projection.items, count: projection.items.length,
        hasMore: page.hasMore, complete: !page.hasMore, pageStatus: page.hasMore ? 'more' : 'done',
        cursor: page.hasMore ? JSON.stringify({ revision, afterId: page.nextAfterId }) : null } };
    } },
    providerFetch: async (_, request) => {
      requests.push(JSON.parse(request.body));
      if (providerFailure) throw new Error('test network failed');
      if (large) {
        const last = requests.at(-1).input.at(-1);
        const tool = last.type === 'function_call_output' ? JSON.parse(last.output) : null;
        const query = !tool ? 'policy.current' : tool.response.body.query === 'policy.current' ? 'run.workset'
          : tool.response.body.query === 'run.workset' && tool.response.body.hasMore ? 'run.workset'
          : tool.response.body.query === 'run.workset' ? 'run.status' : null;
        return Response.json({ id: `response_${requests.length}`, status: 'completed', usage: { input_tokens: 10, output_tokens: 10 },
          output: [{ type: 'compaction', id: `cmp_${requests.length}`, encrypted_content: 'test-opaque-state' },
            ...(query ? [{ type: 'function_call', status: 'completed', call_id: `read${requests.length}`,
              name: query === 'run.status' ? 'quantus_run_status' : 'quantus_context', arguments: JSON.stringify(query === 'run.status' ? { cursor: '' }
                : { query, scopeId: query === 'policy.current' ? 'policy_current' : 'run_2026-10-02',
                  cursor: tool?.response.body.query === 'run.workset' ? tool.response.body.cursor : '' }) }]
              : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'All packets read.' }] }])] });
      }
      return Response.json({ id: `response_${requests.length}`, status: 'completed', usage: { input_tokens: 10, output_tokens: 10 },
        output: [...(compaction && requests.length === 2 ? [{ type: 'compaction', id: 'cmp_composition', encrypted_content: 'test-opaque-state' }] : []),
          ...(requests.length <= 3 ? [{ type: 'function_call', status: 'completed',
          name: requests.length === 3 ? 'quantus_run_status' : 'quantus_context', call_id: `read${requests.length}`,
          arguments: JSON.stringify(requests.length === 3 ? { cursor: '' } : {
            query: requests.length === 1 ? 'policy.current' : 'run.workset',
            scopeId: requests.length === 1 ? 'policy_current' : 'run_2026-10-02', cursor: '',
          }) }]
          : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Review complete; backend proof still required.' }] }])] });
    }, ...overrides });
  return { ...s, args, make, requests, tools, env, config, sourceRequests };
}

test('actual OpenAI worker closes an eligible day through backend checks, replays without a model call, and refuses an open lead', async () => {
  for (const close of [true, 'open']) {
    const s = await build({ close }); let result;
    for (let n = 0; n < 25; n++) {
      result = await (await s.make()).sectionWork.impl.next(s.args);
      if (result.done || result.blocked) break;
    }
    const daily = s.store.snapshot().dailyBriefing.assistantRuns['2026-10-02'];
    if (close === 'open') {
      assert.equal(result.blocked, true, JSON.stringify(result));
      assert.equal(result.reason, 'daily_closure_blocked'); assert.notEqual(daily.phase, 'final');
    } else {
      assert.equal(result.finalized, true, JSON.stringify(result)); assert.equal(daily.phase, 'final');
      assert.ok(s.store.snapshot().entities.chatgptNotes[daily.finalNoteId]);
      const calls = s.requests.length, puts = s.store.stats.puts;
      assert.equal((await (await s.make()).sectionWork.impl.next(s.args)).finalized, true);
      assert.equal(s.requests.length, calls); assert.equal(s.store.stats.puts, puts);
    }
  }
});

test('actual composition migrates legacy questions before provider work without inventing confirmation, and respects dry-run', async () => {
  const s = await build({ legacy: true });
  const result = await (await s.make()).sectionWork.impl.next(s.args);
  assert.match(result.stepId, /^v4-legacy-questions-/);
  assert.equal(s.requests.length, 0);
  const data = s.store.snapshot(), [q] = Object.values(data.automation.questionsById);
  assert.equal(q.status, 'open'); assert.equal(q.legacyAnswerDraft, 'Morgen');
  assert.deepEqual(data.automation.answersById, {}); assert.deepEqual(data.automation.intakeById, {});
  const dry = await build({ legacy: true, mode: 'dry_run' });
  assert.equal((await (await dry.make()).sectionWork.impl.next(dry.args)).blocked, true);
  assert.deepEqual(dry.store.snapshot().automation.questionsById, {}); assert.equal(dry.requests.length, 0);
});

test('actual worker consumes user replies into persistent open work before model delivery, with dry-run protection', async () => {
  const s = await build({ reply: true }); let result;
  for (let n = 0; n < 25; n++) {
    result = await (await s.make()).sectionWork.impl.next(s.args);
    if (result.done || result.blocked) break;
  }
  assert.equal(result.done, true, JSON.stringify(result));
  assert.equal(result.completion, 'wave_processed');
  const data = s.store.snapshot(), answer = data.automation.answersById.a1;
  assert.ok(answer.consumedAt); assert.equal(answer.consumption.kind, 'intake');
  assert.equal(data.automation.intakeById[answer.consumption.intakeId].status, 'open');
  const items = s.requests.flatMap(r => r.input).filter(i => i.type === 'function_call_output')
    .map(i => JSON.parse(i.output)).flatMap(t => t.response.body.items || []);
  assert.ok(items.some(i => i.sourceId === answer.consumption.intakeId && i.text.includes('Bitte den bestehenden Auftrag ausführen.')));
  assert.ok(items.some(i => i.sourceType === 'answer' && JSON.parse(i.contextDetails).consumedIntoIntakeId === answer.consumption.intakeId));
  const dry = await build({ reply: true, mode: 'dry_run' });
  assert.equal((await (await dry.make()).sectionWork.impl.next(dry.args)).blocked, true);
  assert.equal(dry.store.snapshot().automation.answersById.a1.consumedAt, null);
  assert.equal(dry.requests.length, 0);
});

test('actual OpenAI worker acquires Gmail, binds intake and persists source status before the first model call', async () => {
  const s = await build({ acquire: true }); let result;
  for (let n = 0; n < 25; n++) {
    result = await (await s.make()).sectionWork.impl.next(s.args);
    if (result.done || result.blocked) break;
  }
  assert.equal(result.done, true, JSON.stringify(result));
  assert.equal(s.sourceRequests.length, 4);
  const data = s.store.snapshot(), entries = Object.values(data.automation.intakeById);
  assert.equal(entries.length, 1); assert.equal(entries[0].status, 'open');
  assert.equal(data.dailyBriefing.assistantRuns['2026-10-02'].sourceChecks['gmail-inbox'].outcome, 'ok');
  const delivered = s.requests.flatMap(r => r.input).filter(i => i.type === 'function_call_output')
    .map(i => JSON.parse(i.output)).flatMap(t => t.response.body.items || []).find(i => i.sourceType === 'intake');
  assert.ok(delivered.text.includes('Automatically acquired mail reaches the model.'));
  assert.equal(data.automation.runtime.runsByKey[RUN].phase, 'active');
});

test('mail account/source/credentials and dry-run gates cannot silently skip required acquisition', async () => {
  for (const mode of ['account', 'source', 'credentials', 'dry_run']) {
    const s = await build({ acquire: true, mode: mode === 'dry_run' ? 'dry_run' : 'live' });
    if (mode === 'account') delete s.env.QUANTUS_V4_GMAIL_ACCOUNT;
    if (mode === 'source') delete s.env.QUANTUS_V4_GMAIL_SOURCE_ID;
    const ports = await s.make(mode === 'credentials' ? { gmailTokenSource: { available: false } } : {});
    if (mode === 'dry_run') assert.equal((await ports.sectionWork.impl.next(s.args)).blocked, true);
    else assert.equal(ports.sectionWork.available, false);
    assert.equal(s.sourceRequests.length, 0); assert.equal(s.requests.length, 0);
  }
});

test('production composition delivers the exact bound mail original to model input and retains partial-source gates', async () => {
  for (const gmail of [true, 'partial']) {
    const s = await build({ gmail }); let result;
    for (let n = 0; n < 20; n++) {
      result = await (await s.make()).sectionWork.impl.next(s.args);
      if (result.done || result.blocked) break;
    }
    const deliveries = s.requests.flatMap(r => r.input).filter(i => i.type === 'function_call_output')
      .map(i => JSON.parse(i.output)).filter(t => t.response.body.query === 'run.workset');
    const mailItem = deliveries.flatMap(t => t.response.body.items).find(i => i.sourceType === 'intake');
    assert.equal(JSON.parse(mailItem.text).parts[0].text, 'Full source available to the actual model transport.');
    assert.equal(mailItem.sourceMissing, gmail === 'partial');
    if (gmail === 'partial') {
      assert.equal(result.blocked, true); assert.equal(result.reason, 'context_original_missing');
      assert.equal(s.store.snapshot().automation.runtime.runsByKey[RUN].contextCoverage, undefined);
    } else assert.equal(result.done, true, JSON.stringify(result));
  }
});

test('actual worker carries a large mail through all packets and independent completion coverage', async () => {
  const s = await build({ gmail: 'large', large: true, compaction: true }); let result;
  for (let n = 0; n < 90; n++) {
    result = await (await s.make()).sectionWork.impl.next(s.args);
    if (result.done || result.blocked) break;
  }
  assert.equal(result.done, true, JSON.stringify(result));
  const receipts = (await s.journal.read()).map(e => e.tool).filter(t => t?.contextPacket);
  const fragments = receipts.flatMap(r => r.response.body.fragments).filter(f => f.originalId.startsWith('ctx_intake_'));
  assert.ok(fragments.length > 1);
  const item = JSON.parse(fragments.sort((a, b) => a.fragmentIndex - b.fragmentIndex).map(f => f.jsonFragment).join(''));
  assert.equal(JSON.parse(item.text).parts[0].text, 'Full source available to the actual model transport.'.repeat(12000));
  assert.equal(s.store.snapshot().automation.runtime.runsByKey[RUN].contextCoverage.proof.itemCount, 3);
  assert.ok(s.requests.every(r => Buffer.byteLength(JSON.stringify(r)) < 512 * 1024));
});

test('production worker completes full large-original packet coverage across fresh instances and changed runtime revisions', async () => {
  const s = await build({ large: true, compaction: true });
  let result;
  for (let n = 0; n < 50; n++) {
    result = await (await s.make()).sectionWork.impl.next(s.args);
    if (result.done || result.blocked) break;
  }
  assert.equal(result.done, true, JSON.stringify(result));
  const run = s.store.snapshot().automation.runtime.runsByKey[RUN];
  assert.equal(run.contextCoverage.proof.itemCount, 2);
  assert.ok(s.requests.length > 6, 'more than one workset packet was required');
  assert.ok(s.requests.every(r => Buffer.byteLength(JSON.stringify(r)) < 512 * 1024));
  const entries = await s.journal.read();
  const receipts = entries.map(e => e.tool).filter(t => t?.contextPacket);
  assert.equal(receipts.length, receipts[0].contextPacket.count);
  const fragments = receipts.flatMap(r => r.response.body.fragments);
  const original = JSON.parse(fragments.map(f => f.jsonFragment).join(''));
  assert.equal(original.text, 'Large original '.repeat(65000));
  assert.ok(s.tools.some(r => r.searchParams.cursor && !r.searchParams.cursor.startsWith('q4packet.')));
  assert.equal(run.phase, 'active');
});

test('production coverage crosses a history segment without dropping any context packet or original proof', async () => {
  const s = await build({ large: 'long', compaction: true });
  let result;
  for (let n = 0; n < 100; n++) {
    result = await (await s.make()).sectionWork.impl.next(s.args);
    if (result.done || result.blocked) break;
  }
  assert.equal(result.done, true, JSON.stringify(result));
  assert.ok(s.requests.length > 30);
  const run = s.store.snapshot().automation.runtime.runsByKey[RUN];
  assert.equal(run.leadershipJournal.schemaVersion, 3);
  assert.ok(run.leadershipJournal.archivedCount > 0);
  assert.equal(run.contextCoverage.proof.itemCount, 2);
  const entries = await s.journal.read();
  const packets = entries.flatMap(e => e.archived ? (e.coverageFacts.read?.packet ? [e.coverageFacts.read.packet] : [])
    : e.tool?.contextPacket ? [e.tool.contextPacket] : []);
  assert.equal(packets.length, packets[0].count);
  assert.deepEqual(packets.map(p => p.index), Array.from({ length: packets.length }, (_, i) => i));
  assert.equal(run.phase, 'active');
});

test('production compaction retains independent coverage evidence and only uses explicit valid configuration', async () => {
  const s = await build({ compaction: true });
  let outcome;
  for (let i = 0; i < 8; i++) {
    const p = await s.make();
    assert.equal(p.sectionWork.available, true);
    outcome = await p.sectionWork.impl.next(s.args);
    if (outcome.done) break;
  }
  assert.equal(outcome.done, true);
  assert.equal(s.requests.length, 4);
  for (const request of s.requests)
    assert.deepEqual(request.context_management, [{ type: 'compaction', compact_threshold: 16000 }]);
  assert.equal(s.requests[2].input[0].type, 'compaction');
  assert.equal(s.requests[2].input[0].encrypted_content, 'test-opaque-state');
  assert.equal(s.requests[2].input[1].call_id, 'read2');
  const run = s.store.snapshot().automation.runtime.runsByKey[RUN];
  assert.equal(run.contextCoverage.proof.itemCount, 2);
  assert.equal(run.leadershipJournal.entries.length, 4);
  assert.equal(run.phase, 'active', 'compaction and coverage never grant daily finalization');
  for (const threshold of ['', 'invalid', '999', '100001', '16000.5', null]) {
    s.env.QUANTUS_V4_OPENAI_COMPACT_THRESHOLD = threshold;
    assert.equal((await s.make()).sectionWork.reason, 'openai_compaction_not_configured');
  }
  assert.equal(s.requests.length, 4);
});

test('production composition bootstraps real domain, journals provider/tool steps and resumes without granting finalization', async () => {
  const s = await build();
  let p = await s.make();
  assert.equal(p.sectionWork.available, true, p.sectionWork.reason);
  const first = await p.sectionWork.impl.next(s.args);
  assert.match(first.stepId, /:model_recorded$/);
  assert.equal(s.requests.length, 1);
  assert.match(s.requests[0].instructions, /automatische\nArbeitsläufe/);
  const daily = s.store.snapshot().dailyBriefing.assistantRuns['2026-10-02'];
  assert.ok(daily.startNoteId);
  assert.ok(daily.itemRefs.some(r => r.sourceId === 'task1'));
  p = await s.make();
  assert.match((await p.sectionWork.impl.next(s.args)).stepId, /:tool_recorded$/);
  assert.equal(s.tools.length, 1);
  assert.equal(s.tools[0].credential, 'test-job-token');
  assert.match((await p.sectionWork.impl.next(s.args)).stepId, /:model_recorded$/);
  for (let i = 0; i < 2; i++) {
    assert.match((await (await s.make()).sectionWork.impl.next(s.args)).stepId, /:tool_recorded$/);
    assert.match((await (await s.make()).sectionWork.impl.next(s.args)).stepId, /:model_recorded$/);
  }
  const complete = await (await s.make()).sectionWork.impl.next(s.args);
  assert.equal(complete.done, true, JSON.stringify(complete));
  assert.equal(s.requests.length, 4);
  const proof = s.store.snapshot().automation.runtime.runsByKey[RUN].contextCoverage.proof;
  assert.equal(proof.itemCount, 2);
  assert.match(proof.worksetHash, /^[a-f0-9]{64}$/);
  const recordedTools = (await s.journal.read()).filter(e => e.tool);
  assert.equal(recordedTools[1].tool.readPages.length, 2, 'workset spans both pages before journal mutation');
  assert.equal(recordedTools[1].tool.response.body.count, 2);
  assert.equal(s.store.snapshot().dailyBriefing.assistantRuns['2026-10-02'].phase, 'active');
  assert.ok(Object.values(s.store.snapshot().automation.runtime.cost.callsById).every(c => c.state === 'settled'));
  assert.equal(JSON.stringify(s.store.snapshot()).includes('Review complete; backend proof still required.'), false, 'raw response is external');
});

test('unconfirmed provider outcome remains blocked across new worker instances without another call', async () => {
  const s = await build({ providerFailure: true });
  const result = await (await s.make()).sectionWork.impl.next(s.args);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'provider_outcome_unknown');
  assert.equal((await (await s.make()).sectionWork.impl.next(s.args)).blocked, true);
  assert.equal(s.requests.length, 1);
});

test('missing model/prices/version or issuer never falls back to Anthropic or exposes secrets', async () => {
  const s = await build();
  for (const key of ['QUANTUS_V4_OPENAI_MODEL', 'QUANTUS_V4_OPENAI_INPUT_MICROS_PER_MTOK', 'QUANTUS_V4_PROMPT_VERSION']) {
    const p = await s.make({ envRead: name => name === key ? undefined : s.env[name] });
    assert.equal(p.sectionWork.available, false);
    assert.equal(JSON.stringify(p).includes(s.env.QUANTUS_V4_OPENAI_API_KEY), false);
  }
  assert.equal((await s.make({ jobTokenIssuer: { available: false } })).sectionWork.available, false);
  assert.equal(s.requests.length, 0);
});

test('dry-run, revoked cost policy, expired lease and aborted section cannot dispatch a provider request', async () => {
  for (const kind of ['dry_run', 'revoked', 'expired', 'abort']) {
    const s = await build({ mode: kind === 'dry_run' ? 'dry_run' : 'live' });
    const p = await s.make();
    if (kind === 'revoked') delete s.env.QUANTUS_V3_COST_POLICY_JSON;
    if (kind === 'expired') s.setNow(T + 121000);
    const controller = new AbortController(); if (kind === 'abort') controller.abort();
    if (kind === 'dry_run' || kind === 'revoked') {
      const result = await p.sectionWork.impl.next({ ...s.args, signal: controller.signal });
      assert.equal(result.blocked, true);
      assert.equal(result.reason, kind === 'dry_run' ? 'external_effects_not_allowed' : 'cost_policy_unavailable');
    } else await assert.rejects(p.sectionWork.impl.next({ ...s.args, signal: controller.signal }));
    assert.equal(s.requests.length, 0, kind);
    assert.equal(s.tools.length, 0, kind);
  }
});

test('production OpenAI reservation enforces the shared 50 USD monthly cap', async () => {
  const s = await build();
  const large = { ...costPolicy, dayLimitMicros: 100000000, runLimitMicros: 100000000,
    callLimitMicros: 20000000, unresolvedBlockMicros: 100000000,
    models: { ...costPolicy.models, 'openai:earlier-model': {
      inputMicrosPerMillionTokens: 1000000, outputMicrosPerMillionTokens: 0, maxCallMicros: 20000000 } } };
  s.env.QUANTUS_V3_COST_POLICY_JSON = JSON.stringify(large);
  for (let i = 0; i < 5; i++) {
    const key = `earlier-${i}`;
    await s.core.mutate({ commandKey: key, requestId: key, now: T, mutate: d => reserveCost(d, {
      callId: key, runKey: RUN, provider: 'openai', model: 'earlier-model', contentHash: `test-content-hash-${i}`,
      inputTokens: 10000000, outputTokens: 0, now: T, verifiedScope: s.scope, policy: large,
    }) });
  }
  const result = await (await s.make()).sectionWork.impl.next(s.args);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'monthly_budget_exceeded');
  assert.equal(s.requests.length, 0);
});

test('a concurrent original write after the fresh check prevents saving coverage and prompts fresh work on resume', async () => {
  const s = await build();
  for (let i = 0; i < 7; i++) await (await s.make()).sectionWork.impl.next(s.args);
  let changed = false;
  const p = await s.make({ corePort: { ...s.core, async mutate(args) {
    if (!changed && args.commandKey.startsWith('v4-coverage-')) {
      changed = true;
      s.store.forceWrite(d => {
        d.entities.tasks.late = { id: 'late', title: 'Arrived during final check', status: 'todo' };
        d.automation.dataRevision++;
        return d;
      });
    }
    return s.core.mutate(args);
  } } });
  await assert.rejects(p.sectionWork.impl.next(s.args), { error: 'context_changed_before_checkpoint' });
  assert.equal(s.store.snapshot().automation.runtime.runsByKey[RUN].contextCoverage, undefined);
  assert.equal(s.requests.length, 4);
  const resumed = await (await s.make()).sectionWork.impl.next(s.args);
  assert.equal(resumed.done, false);
  assert.match(s.requests[4].input.at(-1).content, /context_contents_changed/);
});
