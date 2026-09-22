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
      alarm_fire_at: new Date(fireAt).toISOString(),
      alarm_interval_seconds: safeSeconds,
      loop_enabled: false
    };

    await this.ctx.storage.put("state", state);

    return {
      state,
      alarm_time_ms: fireAt
    };
  }

  async startLoop(seconds = 120) {
    const safeSeconds = Math.max(5, Math.min(Number(seconds) || 120, 3600));
    const fireAt = Date.now() + safeSeconds * 1000;

    await this.ctx.storage.put("loop_config", {
      enabled: true,
      interval_seconds: safeSeconds
    });

    await this.ctx.storage.put("loop_count", 0);
    await this.ctx.storage.setAlarm(fireAt);

    const state = {
      value: "LOOP_ARMED",
      updated_at: new Date().toISOString(),
      alarm_fire_at: new Date(fireAt).toISOString(),
      alarm_interval_seconds: safeSeconds,
      loop_enabled: true,
      loop_count: 0
    };

    await this.ctx.storage.put("state", state);

    return {
      state,
      alarm_time_ms: fireAt
    };
  }

  async stopLoop() {
    await this.ctx.storage.put("loop_config", {
      enabled: false,
      interval_seconds: null
    });

    await this.ctx.storage.deleteAlarm();

    const previous =
      (await this.ctx.storage.get("state")) ?? {};

    const state = {
      ...previous,
      value: "LOOP_STOPPED",
      updated_at: new Date().toISOString(),
      loop_enabled: false,
      alarm_fire_at: null
    };

    await this.ctx.storage.put("state", state);

    return state;
  }

  async getLoopStatus() {
    const state = await this.getState();
    const config =
      (await this.ctx.storage.get("loop_config")) ?? {
        enabled: false,
        interval_seconds: null
      };
    const alarmTime = await this.ctx.storage.getAlarm();
    const count =
      (await this.ctx.storage.get("loop_count")) ?? 0;

    return {
      state,
      config,
      loop_count: count,
      alarm_time_ms: alarmTime,
      alarm_fire_at:
        alarmTime == null
          ? null
          : new Date(alarmTime).toISOString()
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

    const config =
      (await this.ctx.storage.get("loop_config")) ?? {
        enabled: false,
        interval_seconds: null
      };

    const currentCount =
      (await this.ctx.storage.get("loop_count")) ?? 0;

    const nextCount = currentCount + 1;
    const firedAt = new Date().toISOString();

    await this.ctx.storage.put("loop_count", nextCount);

    let nextFireAt = null;

    if (config.enabled && config.interval_seconds) {
      nextFireAt =
        Date.now() + Number(config.interval_seconds) * 1000;

      await this.ctx.storage.setAlarm(nextFireAt);
    }

    const state = {
      ...previous,
      value: config.enabled ? "CLOUD_LOOP_RUNNING" : "CLOUD_TAKEOVER",
      updated_at: firedAt,
      alarm_fired_at: firedAt,
      loop_enabled: !!config.enabled,
      loop_count: nextCount,
      alarm_interval_seconds:
        config.interval_seconds ?? previous.alarm_interval_seconds ?? null,
      alarm_fire_at:
        nextFireAt == null
          ? null
          : new Date(nextFireAt).toISOString()
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
        version: "0.4.0",
        runtime: "cloudflare-worker+durable-object+self-rescheduling-alarm",
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

    if (url.pathname === "/loop/start") {
      const seconds = url.searchParams.get("seconds") ?? "120";
      const result = await runtime.startLoop(seconds);

      return Response.json({
        ok: true,
        ...result
      });
    }

    if (url.pathname === "/loop/stop") {
      const state = await runtime.stopLoop();

      return Response.json({
        ok: true,
        state
      });
    }

    if (url.pathname === "/loop/status") {
      const result = await runtime.getLoopStatus();

      return Response.json({
        ok: true,
        ...result
      });
    }

    return new Response(
      "RCloud is alive. Try /health, /state, /loop/start?seconds=120, /loop/status, or /loop/stop",
      {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8"
        }
      }
    );
  }
};
