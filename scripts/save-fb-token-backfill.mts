/**
 * Save META_SYSTEM_USER_TOKEN onto the connected Facebook Page, verify scopes,
 * then run Facebook comment reconciliation once.
 */
import "dotenv/config";
import { prisma } from "../lib/db/client";
import { encryptToken } from "../lib/meta/oauth";
import {
  listFacebookPagesForToken,
  subscribeFacebookPageToWebhooks,
} from "../lib/meta/facebook-pages";
import { getMetaGraphApiVersion } from "../lib/env";
import { reconcileFacebookComments } from "../lib/polling/facebook-comment-reconciler";

async function main() {
  const token = process.env.META_SYSTEM_USER_TOKEN?.trim();
  if (!token) throw new Error("META_SYSTEM_USER_TOKEN missing");

  const version = getMetaGraphApiVersion();
  const appId = process.env.FACEBOOK_APP_ID!;
  const appSecret = process.env.FACEBOOK_APP_SECRET!;
  const debugUrl = new URL(`https://graph.facebook.com/${version}/debug_token`);
  debugUrl.searchParams.set("input_token", token);
  debugUrl.searchParams.set("access_token", `${appId}|${appSecret}`);
  const debug = await (await fetch(debugUrl)).json();
  const scopes: string[] = debug?.data?.scopes ?? [];
  console.log("SCOPES", scopes);
  console.log(
    "HAS_pages_read_user_content",
    scopes.includes("pages_read_user_content")
  );

  const pages = await listFacebookPagesForToken(token);
  console.log(
    "PAGES",
    pages.map((p) => ({ id: p.id, name: p.name }))
  );
  if (!pages.length) throw new Error("No pages on token");

  const page =
    pages.find((p) => /salam/i.test(p.name)) ?? pages[0]!;
  const pageToken = page.accessToken;

  let webhookSubscribed = false;
  try {
    const sub = await subscribeFacebookPageToWebhooks(page.id, pageToken);
    webhookSubscribed = Boolean((sub as { success?: boolean }).success ?? true);
  } catch (e) {
    console.warn(
      "Webhook subscribe:",
      e instanceof Error ? e.message : e
    );
  }

  const existing = await prisma.facebookPage.findUnique({
    where: { pageId: page.id },
  });
  const data = {
    name: page.name,
    accessToken: encryptToken(pageToken),
    tokenExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
    webhookSubscribed,
  };

  if (existing) {
    await prisma.facebookPage.update({
      where: { id: existing.id },
      data,
    });
    console.log("Updated FacebookPage", page.id, page.name);
  } else {
    const workspace = await prisma.workspace.findFirst({
      orderBy: { createdAt: "asc" },
    });
    if (!workspace) throw new Error("No workspace");
    await prisma.facebookPage.create({
      data: { ...data, pageId: page.id, workspaceId: workspace.id },
    });
    console.log("Created FacebookPage", page.id);
  }

  console.log("Running Facebook comment backfill…");
  await reconcileFacebookComments();
  console.log("DONE");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
