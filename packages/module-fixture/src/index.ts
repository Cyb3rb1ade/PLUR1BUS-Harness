// The fixture module (2a-H3b-a Task 8): the smallest module the supervisor's tests run. It reports its configured
// greeting in module.status.detail and, with crashAfterMs, exits 1 after that many milliseconds.
import { runModule } from "@plur1bus/module-api";

await runModule({
  async start(ctx) {
    const report = (c: Record<string, unknown>) => ctx.setDetail({ greeting: typeof c.greeting === "string" ? c.greeting : null });
    report(ctx.config());
    const off = ctx.onConfig(report);
    const crashAfterMs = ctx.config().crashAfterMs;
    const crash = typeof crashAfterMs === "number"
      ? setTimeout(() => { ctx.logger.error("crashAfterMs reached, exiting 1", { crashAfterMs }); process.exit(1); }, crashAfterMs)
      : undefined;
    ctx.logger.info("fixture started", { crashAfterMs: crashAfterMs ?? null });
    return {
      async stop() { off(); clearTimeout(crash); },
    };
  },
});
