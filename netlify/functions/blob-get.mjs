import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });

  const key = new URL(req.url).searchParams.get("key");
  if (!key) return Response.json({ error: "Missing key" }, { status: 400 });

  const expectedToken = Netlify.env.get("SYNC_AUTH_TOKEN");
  if (expectedToken) {
    const provided = req.headers.get("Authorization") || "";
    if (provided !== expectedToken && provided !== `Bearer ${expectedToken}`) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const store = getStore("app-sync");
    const { data, etag } = await store.getWithMetadata(key, { type: "text" });
    if (data === null) return Response.json({ error: "Not found" }, { status: 404 });
    return new Response(data, {
      status: 200,
      headers: { "Content-Type": "application/json", "ETag": etag || `"${Date.now()}"` },
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
};

export const config = { path: "/.netlify/functions/blob-get" };
```

---

### DATEI 2

**Dateiname:**
```
netlify/functions/blob-put.mjs
