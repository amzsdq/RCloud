export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "RCloud",
        version: "0.1.0",
        runtime: "cloudflare-worker",
        time: new Date().toISOString()
      });
    }

    return new Response(
      "RCloud is alive. Try /health",
      {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8"
        }
      }
    );
  }
};
