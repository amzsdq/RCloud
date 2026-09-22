import { DurableObject } from "cloudflare:workers";

export class RuntimeState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
  }

  async getState() {
    return (await this.ctx.storage.get("state")) ?? {
      value: "UNINITIALIZED",
      updated_at: null
    };
  }

  async setState(value) {
    const state = {
      value,
      updated_at: new Date().toISOString()
    };

    await this.ctx.storage.put("state", state);
    return state;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const runtime = env.RUNTIME_STATE.getByName("main");

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "RCloud",
        version: "0.2.1",
        runtime: "cloudflare-worker+durable-object",
        time: new Date().toISOString()
      });
    }

    if (url.pathname === "/state") {
      const state = await runtime.getState();

      return Response.json({
        ok: true,
        state
      });
    }

    if (url.pathname === "/state/set") {
      const value = url.searchParams.get("value");

      if (!value) {
        return Response.json(
          {
            ok: false,
            error: "Missing ?value="
          },
          { status: 400 }
        );
      }

      const state = await runtime.setState(value);

      return Response.json({
        ok: true,
        state
      });
    }

    return new Response(
      "RCloud is alive. Try /health, /state, or /state/set?value=TEST",
      {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8"
        }
      }
    );
  }
};
