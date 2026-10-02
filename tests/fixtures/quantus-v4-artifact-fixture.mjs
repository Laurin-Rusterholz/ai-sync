import { createWorkArtifactStore } from '../../runtime/quantus-v3/src/work-artifact-store.mjs';

export function artifactFixture({ tenant = 'quantus', bucket = 'quantus-test-artifacts', timeoutMs = 1000, maxPayloadBytes, intercept } = {}) {
  const objects = new Map(), calls = [];
  let generation = 100, privateBucket = true;
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (intercept) { const response = await intercept(url, options); if (response) return response; }
    const u = new URL(url);
    if (u.pathname === `/storage/v1/b/${bucket}`) return json({ iamConfiguration: {
      publicAccessPrevention: privateBucket ? 'enforced' : 'inherited', uniformBucketLevelAccess: { enabled: true } } });
    const upload = u.pathname.startsWith('/upload/');
    const name = upload ? u.searchParams.get('name') : decodeURIComponent(u.pathname.split('/o/')[1] || '');
    if (upload) {
      if (objects.has(name)) return json({}, 412);
      objects.set(name, { text: options.body, generation: String(++generation) });
      return json({}, 200);
    }
    const found = objects.get(name);
    if (!found) return json({}, 404);
    if (u.searchParams.get('alt') === 'media') {
      if (u.searchParams.get('generation') !== found.generation) return json({}, 404);
      return new Response(found.text);
    }
    return json({ bucket, name, generation: found.generation, size: String(Buffer.byteLength(found.text)) });
  };
  return { objects, calls, setPrivate: v => { privateBucket = v; },
    store: createWorkArtifactStore({ bucket, tenant, timeoutMs, maxPayloadBytes, getAccessToken: async () => 'test-token', fetchImpl }) };
}
