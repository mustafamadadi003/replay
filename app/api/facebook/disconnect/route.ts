import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can disconnect pages" },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const facebookPageId =
    typeof body.facebookPageId === "string" ? body.facebookPageId : null;

  await prisma.facebookPage.deleteMany({
    where: {
      workspaceId: context.workspaceId,
      ...(facebookPageId ? { id: facebookPageId } : {}),
    },
  });

  return NextResponse.json({ success: true });
}
