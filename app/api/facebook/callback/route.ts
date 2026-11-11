import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import { saveFacebookPageConnection } from "@/lib/facebook/save-page-connection";
import { listFacebookPagesForToken } from "@/lib/meta/facebook-pages";
import {
  exchangeFacebookCodeForToken,
  exchangeFacebookLongLivedUserToken,
  verifyOAuthState,
} from "@/lib/meta/oauth";
import { canManageWorkspace } from "@/lib/workspace-access";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const error = request.nextUrl.searchParams.get("error");
  const state = verifyOAuthState(request.nextUrl.searchParams.get("state"));
  const baseUrl = getBaseUrl();

  if (error) {
    return NextResponse.redirect(`${baseUrl}/settings?facebook=denied`);
  }

  if (!code || !state) {
    return NextResponse.redirect(`${baseUrl}/settings?facebook=invalid`);
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(`${baseUrl}/login`);
  }

  const membership = await prisma.workspaceMember.findFirst({
    where: {
      workspaceId: state.workspaceId,
      userId: session.user.id,
    },
  });

  if (!membership || !canManageWorkspace(membership.role)) {
    return NextResponse.redirect(`${baseUrl}/settings?facebook=forbidden`);
  }

  try {
    const redirectUri = `${baseUrl}/api/facebook/callback`;
    const { accessToken: shortLived } = await exchangeFacebookCodeForToken(
      code,
      redirectUri
    );

    let userToken = shortLived;
    try {
      const longLived = await exchangeFacebookLongLivedUserToken(shortLived);
      userToken = longLived.accessToken;
    } catch (exchangeError) {
      console.warn(
        "[Facebook Callback] Long-lived exchange failed; using short-lived token:",
        exchangeError
      );
    }

    const pages = await listFacebookPagesForToken(userToken);
    if (pages.length === 0) {
      return NextResponse.redirect(`${baseUrl}/settings?facebook=no_pages`);
    }

    let connected = 0;
    let blocked = 0;
    for (const page of pages) {
      const result = await saveFacebookPageConnection({
        workspaceId: state.workspaceId,
        page: {
          id: page.id,
          name: page.name,
          accessToken: page.accessToken,
        },
      });
      if (result.ok) connected += 1;
      else blocked += 1;
    }

    if (connected === 0 && blocked > 0) {
      return NextResponse.redirect(
        `${baseUrl}/settings?facebook=already_connected`
      );
    }
    if (connected === 0) {
      return NextResponse.redirect(`${baseUrl}/settings?facebook=no_pages`);
    }

    return NextResponse.redirect(
      `${baseUrl}/settings?facebook=connected&count=${connected}`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Facebook Callback] Error:", err);
    await prisma.operationalEvent
      .create({
        data: {
          source: "SYSTEM",
          level: "ERROR",
          workspaceId: state.workspaceId,
          message: "Facebook connection failed",
          payload: { reason: message },
        },
      })
      .catch(() => {});
    return NextResponse.redirect(
      `${baseUrl}/settings?facebook=failed&reason=${encodeURIComponent(
        message.slice(0, 180)
      )}`
    );
  }
}
