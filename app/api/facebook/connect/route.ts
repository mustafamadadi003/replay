import { NextResponse } from "next/server";
import { getBaseUrl, getMissingFacebookOAuthEnv } from "@/lib/env";
import {
  createOAuthState,
  getFacebookPageAuthorizationUrl,
} from "@/lib/meta/oauth";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export async function GET() {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.redirect(`${getBaseUrl()}/login`);
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.redirect(`${getBaseUrl()}/settings?facebook=forbidden`);
  }

  const missingEnv = getMissingFacebookOAuthEnv();
  if (missingEnv.length > 0) {
    return NextResponse.redirect(
      `${getBaseUrl()}/settings?facebook=misconfigured&missing=${encodeURIComponent(
        missingEnv.join(",")
      )}`
    );
  }

  const redirectUri = `${getBaseUrl()}/api/facebook/callback`;
  const state = createOAuthState(context.workspaceId);

  return NextResponse.redirect(
    getFacebookPageAuthorizationUrl(redirectUri, state)
  );
}
