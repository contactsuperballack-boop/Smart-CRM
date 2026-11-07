/** Background process: reply classification + hourly follow-up scheduler. Run separately from the API. */
import { startClassifyWorker } from "./send-and-classify";
import { startScheduler } from "./follow-up-scheduler";

const classify = startClassifyWorker();
const followups = await startScheduler();
console.log("workers started");

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {          // finish in-flight jobs before the container stops
    await Promise.all([classify.close(), followups.close()]);
    process.exit(0);
  });
}
