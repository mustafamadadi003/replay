import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { ensureWorkspaceForUser } from "@/lib/workspace";

export const runtime = "nodejs";

function sessionCookieName(): string {
  const secure = (process.env.NEXTAUTH_URL ?? "").startsWith("https");
  return secure
    ? "__Secure-authjs.session-token"
    : "authjs.session-token";
}

/**
 * Temporary office login for LAN/tunnel when magic-link previews
 * (WhatsApp etc.) burn the one-time token before the admin opens it.
 * Disable by unsetting OFFICE_ACCESS_CODE.
 */
export async function POST(request: Request) {
  const expected = process.env.OFFICE_ACCESS_CODE?.trim();
  if (!expected) {
    return NextResponse.json(
      { error: "Office login is disabled" },
      { status: 404 }
    );
  }

  let body: { code?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const code = String(body.code ?? "").trim();
  if (!code || code !== expected) {
    // Slow down password guessing on a public URL.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return NextResponse.json({ error: "Invalid code" }, { status: 401 });
  }

  // Single shared office account: the workspace, pages and campaigns all hang
  // off this user, so it must stay the same across deploys.
  const email = (process.env.OFFICE_LOGIN_EMAIL ?? "admin@rahbin.local")
    .trim()
    .toLowerCase();

  const user = await prisma.user.upsert({
    where: { email },
    create: { email, name: email.split("@")[0] ?? "Admin" },
    update: {},
  });

  await ensureWorkspaceForUser(user.id, user.email);

  const sessionToken = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await prisma.session.create({
    data: {
      sessionToken,
      userId: user.id,
      expires,
    },
  });

  const secure = (process.env.NEXTAUTH_URL ?? "").startsWith("https");
  const res = NextResponse.json({
    success: true,
    redirectTo: "/dashboard",
  });
  res.cookies.set(sessionCookieName(), sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure,
    expires,
  });
  return res;
}
