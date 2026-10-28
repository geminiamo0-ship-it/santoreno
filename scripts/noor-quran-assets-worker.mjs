const PREFIX = "quran/hafs/v1.1.1/";
const ALLOWED =
  /^(?:pages\/(?:00[1-9]|0[1-9]\d|[1-5]\d\d|60[0-4])\.(?:svg|json)|text\/chapters\/(?:00[1-9]|0[1-9]\d|1(?:0\d|1[0-4]))\.json|manifest\.json|source-manifest\.json|NOTICE\.txt)$/;

export default {
  async fetch(request, env) {
    const u = new URL(request.url);
    const key = decodeURIComponent(u.pathname).replace(/^\//, "");
    if (request.method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
        },
      });
    if (!["GET", "HEAD"].includes(request.method))
      return new Response("Method not allowed", { status: 405 });
    if (!key.startsWith(PREFIX) || !ALLOWED.test(key.slice(PREFIX.length)))
      return new Response("Not found", { status: 404 });
    const object = await env.QURAN.get(key);
    if (!object) return new Response("Not found", { status: 404 });
    const contentType = key.endsWith(".svg")
      ? "image/svg+xml"
      : key.endsWith(".json")
        ? "application/json"
        : "text/plain";
    return new Response(request.method === "HEAD" ? null : object.body, {
      headers: {
        "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public,max-age=31536000,immutable",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "cross-origin",
      },
    });
  },
};
