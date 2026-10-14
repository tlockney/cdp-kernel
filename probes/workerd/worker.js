// Minimal worker: expose a request-scoped evaluator so the probe can compare
// inspector evaluation (no IoContext) against evaluation inside a request.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/eval") {
      const code = await request.text();
      try {
        const fn = env.UNSAFE.newAsyncFunction(code, "cell");
        const value = await fn();
        return Response.json({ ok: true, value: String(value) });
      } catch (err) {
        return Response.json({ ok: false, error: String(err) });
      }
    }
    return new Response("hello from workerd");
  },
};
