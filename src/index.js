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

    await this.ctx.storage.put("loop", {
      enabled: false,
      interval_seconds: null,
      tick_count: 0
    });

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

  async startLoop(seconds = 60) {
    const safeSeconds = Math.max(30, Math.min(Number(seconds) || 60, 3600));
    const fireAt = Date.now() + safeSeconds * 1000;

    const loop = {
      enabled: true,
      interval_seconds: safeSeconds,
      tick_count: 0,
      started_at: new Date().toISOString(),
      last_fired_at: null,
      next_fire_at: new Date(fireAt).toISOString()
    };

    await this.ctx.storage.put("loop", loop);
    await this.ctx.storage.setAlarm(fireAt);

    const state = {
      value: "CLOUD_LOOP_ARMED",
      updated_at: new Date().toISOString(),
      alarm_fire_at: loop.next_fire_at,
      tick_count: 0
    };

    await this.ctx.storage.put("state", state);

    return {
      loop,
      state,
      alarm_time_ms: fireAt
    };
  }

  async stopLoop() {
    const loop =
      (await this.ctx.storage.get("loop")) ?? {
        enabled: false,
        interval_seconds: null,
        tick_count: 0
      };

    loop.enabled = false;
    loop.stopped_at = new Date().toISOString();
    loop.next_fire_at = null;

    await this.ctx.storage.put("loop", loop);
    await this.ctx.storage.deleteAlarm();

    const state = {
      ...(await this.ctx.storage.get("state")),
      value: "CLOUD_LOOP_STOPPED",
      updated_at: new Date().toISOString()
    };

    await this.ctx.storage.put("state", state);

    return { loop, state };
  }

  async getLoopStatus() {
    const loop =
      (await this.ctx.storage.get("loop")) ?? {
        enabled: false,
        interval_seconds: null,
        tick_count: 0
      };

    const alarmTime = await this.ctx.storage.getAlarm();

    return {
      loop,
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

    const loop =
      (await this.ctx.storage.get("loop")) ?? {
        enabled: false,
        interval_seconds: null,
        tick_count: 0
      };

    const firedAtMs = Date.now();
    const firedAt = new Date(firedAtMs).toISOString();

    if (loop.enabled) {
      const intervalSeconds = Math.max(
        30,
        Math.min(Number(loop.interval_seconds) || 60, 3600)
      );

      const nextFireAtMs = firedAtMs + intervalSeconds * 1000;

      const nextLoop = {
        ...loop,
        enabled: true,
        interval_seconds: intervalSeconds,
        tick_count: Number(loop.tick_count || 0) + 1,
        last_fired_at: firedAt,
        next_fire_at: new Date(nextFireAtMs).toISOString()
      };

      const state = {
        ...previous,
        value: "CLOUD_LOOP_TICK",
        updated_at: firedAt,
        alarm_fired_at: firedAt,
        alarm_fire_at: nextLoop.next_fire_at,
        tick_count: nextLoop.tick_count
      };

      await this.ctx.storage.put("loop", nextLoop);
      await this.ctx.storage.put("state", state);

      // Self-reschedule: the cloud runtime re-arms itself.
      await this.ctx.storage.setAlarm(nextFireAtMs);
      return;
    }

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
      const seconds = url.searchParams.get("seconds") ?? "60";
      const result = await runtime.startLoop(seconds);

      return Response.json({
        ok: true,
        ...result
      });
    }

    if (url.pathname === "/loop/status") {
      const result = await runtime.getLoopStatus();

      return Response.json({
        ok: true,
        ...result
      });
    }

    if (url.pathname === "/loop/stop") {
      const result = await runtime.stopLoop();

      return Response.json({
        ok: true,
        ...result
      });
    }

    return new Response(
      "RCloud is alive. Try /health, /state, /loop/start?seconds=60, /loop/status, or /loop/stop",
      {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8"
        }
      }
    );
  }
};
