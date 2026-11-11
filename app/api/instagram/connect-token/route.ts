import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { canConnectInstagramAccount } from "@/lib/instagram-accounts";
import {
  discoverUnifiedInstagramAccounts,
  fetchInstagramAccountById,
  subscribeInstagramAccountToWebhooks,
} from "@/lib/meta/client";
import { encryptToken } from "@/lib/meta/oauth";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";

type DiscoveredAccount = {
  id: string;
  username?: string | null;
  name?: string | null;
};

async function saveOneInstagramAccount(opts: {
  workspaceId: string;
  accessToken: string;
  account: DiscoveredAccount;
}) {
  const connection = await canConnectInstagramAccount({
    workspaceId: opts.workspaceId,
    instagramId: opts.account.id,
  });
  if (!connection.allowed) {
    return { ok: false as const, reason: "already_connected" as const };
  }

  let webhookSubscribed = false;
  try {
    const subscription = await subscribeInstagramAccountToWebhooks(
      opts.account.id,
      opts.accessToken
    );
    webhookSubscribed = Boolean(subscription.success);
  } catch (subscriptionError) {
    console.warn(
      "[Instagram Token Connect] Webhook subscription failed:",
      subscriptionError
    );
  }

  const encryptedToken = encryptToken(opts.accessToken);
  const tokenExpiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
  const data = {
    username: opts.account.username ?? opts.account.id,
    name: opts.account.name ?? null,
    accessToken: encryptedToken,
    tokenExpiresAt,
    webhookSubscribed,
  };

  const existing = await prisma.instagramAccount.findUnique({
    where: { instagramId: opts.account.id },
  });
  if (existing) {
    const updated = await prisma.instagramAccount.updateMany({
      where: {
        id: existing.id,
        workspaceId: opts.workspaceId,
        provider: "META",
      },
      data,
    });
    if (!updated.count) {
      return { ok: false as const, reason: "already_connected" as const };
    }
  } else {
    await prisma.instagramAccount.create({
      data: {
        ...data,
        workspaceId: opts.workspaceId,
        instagramId: opts.account.id,
        provider: "META",
      },
    });
  }

  return {
    ok: true as const,
    username: data.username,
    instagramId: opts.account.id,
    webhookSubscribed,
  };
}

/**
 * First-party System User token import for one or more Instagram accounts.
 * When multiple accounts are discovered and none were selected, returns
 * `multiple_accounts` with a picker list for the UI.
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const context = await getCurrentWorkspaceContext();
  if (!context || !canManageWorkspace(context.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    accessToken?: string;
    instagramId?: string;
    instagramIds?: string[];
  } | null;

  const accessToken = body?.accessToken?.trim();
  if (!accessToken) {
    return NextResponse.json({ error: "access_token_required" }, { status: 400 });
  }

  const requestedIds = [
    ...new Set(
      [
        ...(Array.isArray(body?.instagramIds) ? body.instagramIds : []),
        body?.instagramId?.trim() || "",
      ]
        .map((id) => id.trim())
        .filter(Boolean)
    ),
  ];

  try {
    const discovered = await discoverUnifiedInstagramAccounts(accessToken);

    if (requestedIds.length === 0) {
      if (discovered.length === 0) {
        return NextResponse.json(
          {
            error: "no_instagram_account",
            message:
              "Token is valid but no Instagram account was found. Assign the Instagram asset and Page to the System User, regenerate the token with pages_show_list + instagram_basic, then try again.",
          },
          { status: 400 }
        );
      }
      if (discovered.length > 1) {
        return NextResponse.json(
          {
            error: "multiple_accounts",
            message:
              "Multiple Instagram accounts found. Select the accounts to connect.",
            accounts: discovered.map((a) => ({
              id: a.id,
              username: a.username ?? a.id,
              name: a.name ?? null,
            })),
          },
          { status: 400 }
        );
      }
      requestedIds.push(discovered[0]!.id);
    }

    const connected: Array<{
      username: string;
      instagramId: string;
      webhookSubscribed: boolean;
    }> = [];
    const skipped: Array<{ instagramId: string; reason: string }> = [];

    for (const instagramId of requestedIds) {
      let account: DiscoveredAccount | null =
        discovered.find((a) => a.id === instagramId) ?? null;
      if (!account) {
        account = await fetchInstagramAccountById(accessToken, instagramId);
      }
      if (!account?.id) {
        skipped.push({ instagramId, reason: "not_found" });
        continue;
      }

      const result = await saveOneInstagramAccount({
        workspaceId: context.workspaceId,
        accessToken,
        account,
      });
      if (!result.ok) {
        skipped.push({ instagramId: account.id, reason: result.reason });
        continue;
      }
      connected.push({
        username: result.username,
        instagramId: result.instagramId,
        webhookSubscribed: result.webhookSubscribed,
      });
    }

    if (connected.length === 0) {
      const onlyAlready =
        skipped.length > 0 && skipped.every((s) => s.reason === "already_connected");
      return NextResponse.json(
        {
          error: onlyAlready ? "already_connected" : "connect_failed",
          message: onlyAlready
            ? "Selected accounts are already connected to another workspace."
            : "Could not connect the selected Instagram accounts.",
          skipped,
        },
        { status: onlyAlready ? 409 : 400 }
      );
    }

    return NextResponse.json({
      ok: true,
      accounts: connected,
      skipped,
      username: connected[0]!.username,
      instagramId: connected[0]!.instagramId,
      webhookSubscribed: connected[0]!.webhookSubscribed,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Instagram Token Connect] Error:", error);
    return NextResponse.json({ error: "connect_failed", message }, { status: 400 });
  }
}
