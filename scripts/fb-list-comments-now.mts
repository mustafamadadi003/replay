import "dotenv/config";
import { prisma } from "../lib/db/client";
import { createFacebookContext } from "../lib/facebook/context";
import { listFacebookPostComments } from "../lib/meta/facebook-messages";

async function main() {
  const page = await prisma.facebookPage.findFirst();
  const campaign = await prisma.automation.findFirst({
    where: { facebookPageId: { not: null } },
  });
  if (!page || !campaign?.postId) throw new Error("missing page/campaign");
  const ctx = createFacebookContext(page);
  const { comments } = await listFacebookPostComments(
    ctx.accessToken,
    campaign.postId,
    { limit: 50 }
  );
  console.log("TOTAL", comments.length);
  const matched = comments.filter((c) => (c.message ?? "").includes("لیست"));
  console.log("MATCHED", matched.length);
  for (const c of matched.slice(0, 20)) {
    console.log(c.id, c.from?.name, c.created_time, JSON.stringify(c.message));
  }
  // also show a few recent any comments
  console.log("RECENT_ANY");
  for (const c of comments.slice(-10)) {
    console.log(c.id, c.from?.name, JSON.stringify(c.message)?.slice(0, 80));
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
