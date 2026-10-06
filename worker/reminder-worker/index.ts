interface ReminderEnv {
  APP_URL: string;
  CRON_SECRET: string;
}
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
export default {
  async scheduled(_event: unknown, env: ReminderEnv, ctx: ExecutionContext) {
    if (!env.APP_URL || !env.CRON_SECRET)
      throw new Error("Set APP_URL and CRON_SECRET Worker secrets");
    const url = new URL("/api/cron/reminders", env.APP_URL);
    if (
      url.protocol !== "https:" &&
      url.hostname !== "localhost" &&
      url.hostname !== "127.0.0.1"
    )
      throw new Error("Use HTTPS for the reminder endpoint");
    ctx.waitUntil(
      (async () => {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.CRON_SECRET}`,
            "Content-Type": "application/json",
          },
          body: "{}",
          redirect: "error",
          signal: AbortSignal.timeout(55000),
        });
        if (!response.ok)
          throw new Error(`Reminder job failed (${response.status})`);
        console.info(
          JSON.stringify({
            event: "commitos.reminder_tick",
            status: response.status,
            result: await response.json(),
          }),
        );
      })(),
    );
  },
  async fetch() {
    return new Response(
      "CommitOS reminder worker. Cron invokes shared rules through the authenticated app API.",
      { headers: { "Content-Type": "text/plain" } },
    );
  },
};
