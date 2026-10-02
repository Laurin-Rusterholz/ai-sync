/** Model-facing gateway. Identity, job, lease and replay keys are runtime data.
 * Authority is still checked on every object by the real Quantus API.
 * No provider calls, retries, database access or completion claims here.
 */
import { createHash } from 'node:crypto';
import { ROLE_POLICY } from '../../../netlify/lib/quantus-v3-auth.mjs';
import { COMMAND_VERBS, parseCommandEnvelope } from '../../../netlify/lib/quantus-v3-command-envelope.mjs';
import { NAMED_QUERIES } from '../../../netlify/lib/quantus-v3-cursor.mjs';
import { validateSchema } from './schema.mjs';
import { runIdForRunKey, statusScopeIdForRunKey } from './run-ids.mjs';
import { HttpError } from './errors.mjs';
import { ORIGINAL_READBACK_KINDS, validOriginalId } from '../../../netlify/lib/quantus-v4-readback.mjs';
import { completeToolRead } from './complete-tool-read.mjs';

const ID = { type: 'string', pattern: '^[A-Za-z0-9_:-]{1,120}$' };
const CURSOR = { type: 'string', maxLength: 4096 };
const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const COMMANDS = Object.keys(ROLE_POLICY.lead_agent.verbs).filter(v => v !== 'context.read' && Object.hasOwn(COMMAND_VERBS, v));
const ROUTES = Object.freeze({ quantus_context: 'quantus-context', quantus_read: 'quantus-read',
  quantus_command: 'quantus-ingest', quantus_run_status: 'quantus-run-status' });

export function leadershipToolDefinitions() {
  const read = queries => object({ query: { type: 'string', enum: queries }, scopeId: ID, cursor: CURSOR });
  return [
    { name: 'quantus_context', description: 'Read assigned live context, notes or policy. Empty cursor starts a page; follow hasMore/cursor until complete.',
      parameters: read(['run.context', 'run.workset', 'lead.context', 'notes.recent', 'policy.current']) },
    { name: 'quantus_read', description: 'Read an authorized original lead or its notes and policy. Empty cursor starts a page. A partial page is not complete context.',
      parameters: read(['lead.context', 'notes.recent', 'policy.current']) },
    { name: 'quantus_command', description: 'Request one permitted domain action. payloadJson is the JSON object for that verb from the active Quantus command contract. Never include identity, permissions, lease, paths or finalization fields. A dry-run is not a saved change.',
      parameters: object({ verb: { type: 'string', enum: COMMANDS }, expectedEntityVersion: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, payloadJson: { type: 'string', maxLength: 48000 } }) },
    { name: 'quantus_run_status', description: 'Read the current server-calculated status of the assigned daily run. This tool cannot finalize the day.',
      parameters: object({ cursor: CURSOR }) },
  ];
}

export function createLeadershipGateway({ transport, jobTokenIssuer, clock, runKey, tenant, toolsEnabled, lease, signal }) {
  const jobId = runIdForRunKey(runKey);
  const statusId = statusScopeIdForRunKey(runKey);
  const definitions = leadershipToolDefinitions();
  if (!transport?.send || !jobTokenIssuer?.mint || !clock?.now || typeof tenant !== 'string' || !tenant || typeof lease !== 'function') throw new TypeError('leadership_gateway_configuration_missing');
  return Object.freeze({
    definitions: () => structuredClone(definitions),
    async execute({ name, arguments: args }, { responseId, callId } = {}) {
      const checkAbort = () => { if (signal?.aborted) throw new HttpError(409, 'leadership_interrupted'); };
      checkAbort();
      const definition = definitions.find(t => t.name === name);
      if (!definition || !validateSchema(args, definition.parameters).ok) throw new HttpError(400, 'leadership_tool_arguments_invalid');
      if (toolsEnabled?.[name] !== true) throw new HttpError(503, 'tool_disabled');
      if (![responseId, callId].every(x => typeof x === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(x))) throw new HttpError(400, 'leadership_call_identity_missing');
      const route = ROUTES[name];
      const stableKey = 'q4-' + createHash('sha256').update(JSON.stringify([jobId, responseId, callId])).digest('hex');
      let payload = null, searchParams = null;
      if (name === 'quantus_command') {
        let parsed;
        try { parsed = JSON.parse(args.payloadJson); } catch { throw new HttpError(400, 'leadership_payload_not_json'); }
        const activeLease = await lease();
        const envelope = parseCommandEnvelope({ schemaVersion: 3, jobId, verb: args.verb,
          expectedEntityVersion: args.expectedEntityVersion, payload: parsed, lease: activeLease });
        if (!envelope.ok) throw new HttpError(envelope.status || 400, 'leadership_command_invalid', { reason: envelope.reason });
        if (!envelope.command.lease) throw new HttpError(409, 'leadership_lease_missing');
        payload = envelope.command;
      } else {
        const query = name === 'quantus_run_status' ? 'run.status' : args.query;
        searchParams = { query: name === 'quantus_run_status' ? 'run.status' : args.query,
          scopeId: name === 'quantus_run_status' ? statusId : args.scopeId,
          jobId, pageSize: String(Math.min(50, NAMED_QUERIES[query].maxPageSize)), ...(args.cursor ? { cursor: args.cursor } : {}) };
      }
      const credential = await jobTokenIssuer.mint({ audience: route, jobId, tenant, now: clock.now() });
      if (typeof credential !== 'string' || !credential) throw new HttpError(503, 'job_token_mint_failed');
      checkAbort();
      let response = await transport.send({ route, method: payload ? 'POST' : 'GET', credential,
        payload, searchParams, idempotencyKey: payload ? stableKey : null, timeoutMs: 20000, signal });
      checkAbort();
      let read;
      if (!payload) {
        read = await completeToolRead({ first: response, query: searchParams.query, scopeId: searchParams.scopeId,
          cursor: args.cursor, signal, next: async cursor => {
            checkAbort();
            const token = await jobTokenIssuer.mint({ audience: route, jobId, tenant, now: clock.now() });
            checkAbort();
            return transport.send({ route, method: 'GET', credential: token,
              searchParams: { ...searchParams, cursor }, timeoutMs: 20000, signal });
          } });
        response = read.response;
      }
      // HTTP success alone never proves a write; preserve a dry-run distinctly.
      // HTTP/schema/permission failures go back for deliberate reevaluation.
      const receipt = response?.body;
      const metadataValid = Boolean(receipt && typeof receipt.requestId === 'string' && receipt.requestId
        && typeof receipt.serverNow === 'string' && Number.isFinite(Date.parse(receipt.serverNow))
        && Number.isSafeInteger(receipt.dataRevision) && receipt.dataRevision >= 0);
      const pageValid = Boolean(receipt && Array.isArray(receipt.items) && typeof receipt.hasMore === 'boolean'
        && typeof receipt.complete === 'boolean' && (!receipt.hasMore || (typeof receipt.cursor === 'string' && receipt.cursor)));
      let confirmed = Boolean(response?.status === 200 && receipt?.ok === true && metadataValid
        && (payload ? receipt.applied === true && receipt.dryRun === false : pageValid && read?.readComplete === true));
      let readback;
      if (payload && confirmed) {
        // The acknowledgement proves application, not the independently read
        // original. Old servers without typed proof references cannot pass.
        const refs = receipt.readbackRefs;
        const validRefs = Array.isArray(refs) && refs.length > 0 && refs.length <= 8
          && refs.every(r => r && Object.keys(r).sort().join(',') === 'entityVersion,fingerprint,originalId,originalKind'
            && ORIGINAL_READBACK_KINDS.includes(r.originalKind) && validOriginalId(r.originalId)
            && Number.isSafeInteger(r.entityVersion) && r.entityVersion >= 0
            && receipt.entityVersions?.[r.originalId] === r.entityVersion
            && typeof r.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(r.fingerprint))
          && new Set(refs.map(r => `${r.originalKind}:${r.originalId}`)).size === refs.length;
        readback = { confirmed: false, reason: 'readback_references_invalid', originals: [] };
        if (validRefs && toolsEnabled?.quantus_read === true) {
          try {
            let revision = null;
            for (const ref of refs) {
              checkAbort(); await lease(); checkAbort();
              const token = await jobTokenIssuer.mint({ audience: 'quantus-read', jobId, tenant, now: clock.now() });
              checkAbort();
              const reread = await transport.send({ route: 'quantus-read', method: 'GET', credential: token,
                searchParams: { query: 'run.readback', scopeId: jobId, jobId, pageSize: '1', targetKind: ref.originalKind, targetId: ref.originalId },
                timeoutMs: 20000, signal });
              checkAbort();
              const body = reread?.body, original = body?.items?.[0];
              if (reread?.status !== 200 || body?.ok !== true || typeof body.requestId !== 'string' || !body.requestId
                || typeof body.serverNow !== 'string' || !Number.isFinite(Date.parse(body.serverNow)) || !Number.isSafeInteger(body.dataRevision)
                || body.dataRevision < receipt.dataRevision || (revision !== null && revision !== body.dataRevision)
                || body.query !== 'run.readback' || body.scopeId !== jobId || body.hasMore !== false
                || body.complete !== true || body.pageStatus !== 'done' || body.cursor !== null
                || body.count !== 1 || body.items.length !== 1 || original?.runId !== jobId
                || original.originalKind !== ref.originalKind || original.originalId !== ref.originalId
                || original.entityVersion !== ref.entityVersion || original.fingerprint !== ref.fingerprint)
                throw new HttpError(502, 'original_readback_mismatch');
              revision = body.dataRevision;
              readback.originals.push({ ...ref, dataRevision: revision, requestId: body.requestId, serverNow: body.serverNow });
            }
            readback.confirmed = true; readback.reason = null;
          } catch {
            readback.reason = signal?.aborted ? 'readback_interrupted' : 'original_readback_unconfirmed';
          }
        } else if (validRefs) readback.reason = 'readback_tool_disabled';
        confirmed = readback.confirmed;
      }
      return { confirmed, idempotencyKey: payload ? stableKey : null, response, ...(readback ? { readback } : {}),
        ...(read ? { readPages: read.readPages, readComplete: read.readComplete, ...(read.readFailure ? { readFailure: read.readFailure } : {}) } : {}) };
    },
  });
}
