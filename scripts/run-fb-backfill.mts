import "dotenv/config";
import { prisma } from "../lib/db/client";
import { getDMQueue } from "../lib/queue/client";
import { reconcileFacebookComments } from "../lib/polling/facebook-comment-reconciler";

async function main() {
  await reconcileFacebookComments();
  const logs = await prisma.dmLog.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  console.log("DMLOGS", logs);
  const q = getDMQueue();
  console.log(
    "QUEUE",
    await q.getJobCounts("waiting", "active", "delayed", "failed", "completed")
  );
  await q.close();
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
