import { prisma } from "@/lib/db/client";

export async function canConnectFacebookPage(input: {
  workspaceId: string;
  pageId: string;
}): Promise<{ allowed: true } | { allowed: false; reason: "already_connected" }> {
  const existing = await prisma.facebookPage.findUnique({
    where: { pageId: input.pageId },
    select: { workspaceId: true },
  });
  if (existing && existing.workspaceId !== input.workspaceId) {
    return { allowed: false, reason: "already_connected" };
  }
  return { allowed: true };
}
