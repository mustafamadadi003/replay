import { prisma } from "../lib/db/client";
import { getDMQueue } from "../lib/queue/client";

async function main() {
  const pages = await prisma.facebookPage.findMany({
    select: { id: true, pageId: true, name: true, webhookSubscribed: true },
  });
  console.log("PAGES", pages);

  const campaigns = await prisma.automation.findMany({
    where: { OR: [{ facebookPageId: { not: null } }, { name: "لیست استخدام" }] },
    select: {
      id: true,
      name: true,
      isActive: true,
      facebookPageId: true,
      postId: true,
      keywords: true,
    },
  });
  console.log("CAMPAIGNS", campaigns);

  for (const c of campaigns) {
    const logs = await prisma.dmLog.groupBy({
      by: ["status"],
      where: { automationId: c.id },
      _count: { _all: true },
    });
    console.log("LOGS", c.name, logs);
  }

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
