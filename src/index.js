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

  async armAlarm(seconds = 120) {
    const safeSeconds = Math.max(5, Math.min(Number(seconds) || 120, 3600));
    const fireAt = Date.now() + safeSeconds * 1000;

    await this.ctx.storage.setAlarm(fireAt);

    const state = {
      value: "ALARM_ARMED",
      updated_at: new Date().toISOString(),
      alarm_fire_at: new Date(fireAt).toISOString()
    };

    await this.ctx.storage.put("state", state);

    return {
      state,
      alarm_time_ms: fireAt
    };
  }

  async getAlarmStatus() {
    const alarmTime = await this.ctx.storage.getAlarm();

    return {
      alarm_time_ms: alarmTime,
      alarm_fire_at:
        alarmTime == null
          ? null
          : new Date(alarmTime).toISOString()
    };
  }

  async alarm() {
    const previous =
      (await this.ctx.storage.get("state")) ?? {};

    const firedAt = new Date().toISOString();

    const state = {
      ...previous,
      value: "CLOUD_TAKEOVER",
      updated_at: firedAt,
      alarm_fired_at: firedAt
    };

    await this.ctx.storage.put("state", state);
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
        version: "0.3.0",
        runtime: "cloudflare-worker+durable-object+alarm",
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

    if (url.pathname === "/alarm/arm") {
      const seconds = url.searchParams.get("seconds") ?? "120";
      const result = await runtime.armAlarm(seconds);

      return Response.json({
        ok: true,
        ...result
      });
    }

    if (url.pathname === "/alarm/status") {
      const result = await runtime.getAlarmStatus();

      return Response.json({
        ok: true,
        ...result
      });
    }

    return new Response(
      "RCloud is alive. Try /health, /state, /alarm/arm?seconds=120, or /alarm/status",
      {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8"
        }
      }
    );
  }
};
