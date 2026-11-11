"use client";

import LanguageSwitcher from "@/components/language-switcher";
import { useI18n } from "@/lib/i18n/provider";
import { Suspense, useEffect, useState } from "react";
import type { AccountOption } from "@/components/account-select";
import { ZernioConnection } from "@/components/zernio-connection";
import { MetaConnectNotice } from "@/components/meta-connect-notice";

interface SettingsData {
  workspace: {
    name: string;
    dmsSentThisPeriod: number;
  };
  instagramAccount: {
    id: string;
    username: string;
    instagramId: string;
    tokenExpiresAt: string | null;
    webhookSubscribed: boolean;
  } | null;
  instagramAccounts: Array<
    AccountOption & {
      provider?: "META" | "ZERNIO";
      tokenExpiresAt: string | null;
      webhookSubscribed: boolean;
    }
  >;
}

interface WorkspaceMembersData {
  currentUserRole: "OWNER" | "ADMIN" | "MEMBER";
  members: Array<{
    id: string;
    role: "OWNER" | "ADMIN" | "MEMBER";
    createdAt: string;
    user: {
      id: string;
      email: string | null;
      name: string | null;
    };
  }>;
  invitations: Array<{
    id: string;
    email: string;
    role: "OWNER" | "ADMIN" | "MEMBER";
    inviteUrl: string;
    expiresAt: string;
  }>;
}

export default function SettingsPage() {
  const { t, label, locale } = useI18n();
  const [data, setData] = useState<SettingsData | null>(null);
  const [membersData, setMembersData] = useState<WorkspaceMembersData | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"ADMIN" | "MEMBER">("MEMBER");
  const [memberError, setMemberError] = useState<string | null>(null);
  const [systemUserToken, setSystemUserToken] = useState("");
  const [systemUserIgId, setSystemUserIgId] = useState("");
  const [tokenConnectError, setTokenConnectError] = useState<string | null>(null);
  const [tokenConnectOk, setTokenConnectOk] = useState<string | null>(null);
  const [instagramChoices, setInstagramChoices] = useState<
    Array<{ id: string; username: string; name: string | null }>
  >([]);
  const [selectedInstagramIds, setSelectedInstagramIds] = useState<string[]>([]);
  const [facebookPages, setFacebookPages] = useState<
    Array<{
      id: string;
      pageId: string;
      name: string;
      tokenExpiresAt: string | null;
      webhookSubscribed: boolean;
    }>
  >([]);
  const [facebookToken, setFacebookToken] = useState("");
  const [facebookPageId, setFacebookPageId] = useState("");
  const [facebookChoices, setFacebookChoices] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [selectedFacebookPageIds, setSelectedFacebookPageIds] = useState<
    string[]
  >([]);
  const [facebookConnectError, setFacebookConnectError] = useState<string | null>(
    null
  );
  const [facebookConnectOk, setFacebookConnectOk] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/dashboard/stats").then((res) => res.json()),
      fetch("/api/workspace/members").then((res) => res.json()),
      fetch("/api/facebook/pages").then((res) => res.json()),
    ])
      .then(([statsPayload, membersPayload, facebookPayload]) => {
        if (statsPayload.success) setData(statsPayload.data);
        if (membersPayload.success) setMembersData(membersPayload.data);
        if (facebookPayload.success) setFacebookPages(facebookPayload.data.pages);
      })
      .finally(() => setLoading(false));
  }, []);

  async function refreshMembers() {
    const res = await fetch("/api/workspace/members");
    const payload = await res.json();
    if (payload.success) setMembersData(payload.data);
  }

  async function disconnectInstagram(instagramAccountId: string) {
    if (!confirm(t("Disconnect Instagram? Campaigns for this account will stop sending DMs."))) {
      return;
    }

    setBusy(`disconnect:${instagramAccountId}`);
    await fetch("/api/instagram/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instagramAccountId }),
    });
    window.location.reload();
  }

  async function refreshFacebookPages() {
    const res = await fetch("/api/facebook/pages");
    const payload = await res.json();
    if (payload.success) setFacebookPages(payload.data.pages);
  }

  async function disconnectFacebookPage(facebookPageIdToRemove: string) {
    if (
      !confirm(
        t("Disconnect Facebook Page? Comment-to-DM for this Page will stop.")
      )
    ) {
      return;
    }
    setBusy(`fb-disconnect:${facebookPageIdToRemove}`);
    await fetch("/api/facebook/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ facebookPageId: facebookPageIdToRemove }),
    });
    await refreshFacebookPages();
    setBusy(null);
  }

  function toggleId(list: string[], id: string) {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  }

  async function connectFacebookWithToken(forcePageIds?: string[]) {
    setFacebookConnectError(null);
    setFacebookConnectOk(null);
    setBusy("fb-token-connect");
    try {
      const pageIds =
        forcePageIds ??
        (selectedFacebookPageIds.length > 0
          ? selectedFacebookPageIds
          : facebookPageId.trim()
            ? [facebookPageId.trim()]
            : undefined);
      const res = await fetch("/api/facebook/connect-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessToken: facebookToken.trim(),
          pageIds,
        }),
      });
      const payload = await res.json();
      if (!res.ok) {
        if (payload.error === "multiple_pages" && Array.isArray(payload.pages)) {
          setFacebookChoices(payload.pages);
          setSelectedFacebookPageIds(
            payload.pages.map((p: { id: string }) => p.id)
          );
          setFacebookConnectError(
            t("Multiple pages found. Select the pages to connect, then save again.")
          );
        } else {
          setFacebookConnectError(
            payload.message ?? payload.error ?? t("Connection failed")
          );
        }
        return;
      }
      const count = Array.isArray(payload.pages) ? payload.pages.length : 1;
      setFacebookConnectOk(
        t("{count} Facebook Page(s) connected", { count })
      );
      setFacebookToken("");
      setFacebookPageId("");
      setFacebookChoices([]);
      setSelectedFacebookPageIds([]);
      await refreshFacebookPages();
    } catch {
      setFacebookConnectError(t("Connection failed"));
    } finally {
      setBusy(null);
    }
  }

  async function connectWithSystemUserToken(forceInstagramIds?: string[]) {
    setTokenConnectError(null);
    setTokenConnectOk(null);
    setBusy("token-connect");
    try {
      const instagramIds =
        forceInstagramIds ??
        (selectedInstagramIds.length > 0
          ? selectedInstagramIds
          : systemUserIgId.trim()
            ? [systemUserIgId.trim()]
            : undefined);
      const res = await fetch("/api/instagram/connect-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessToken: systemUserToken.trim(),
          instagramIds,
        }),
      });
      const payload = await res.json();
      if (!res.ok) {
        if (
          payload.error === "multiple_accounts" &&
          Array.isArray(payload.accounts)
        ) {
          setInstagramChoices(payload.accounts);
          setSelectedInstagramIds(
            payload.accounts.map((a: { id: string }) => a.id)
          );
          setTokenConnectError(
            t(
              "Multiple Instagram accounts found. Select the accounts to connect, then save again."
            )
          );
        } else {
          setTokenConnectError(
            payload.message ?? payload.error ?? t("Connection failed")
          );
        }
        return;
      }
      const names = Array.isArray(payload.accounts)
        ? payload.accounts.map((a: { username: string }) => a.username).join(", ")
        : payload.username;
      setTokenConnectOk(t("Connected: {names}", { names }));
      setSystemUserToken("");
      setSystemUserIgId("");
      setInstagramChoices([]);
      setSelectedInstagramIds([]);
      window.location.reload();
    } catch (error) {
      setTokenConnectError(
        error instanceof Error ? error.message : t("Connection failed")
      );
    } finally {
      setBusy(null);
    }
  }

  async function inviteMember(event: React.FormEvent) {
    event.preventDefault();
    setMemberError(null);
    setBusy("invite");
    const res = await fetch("/api/workspace/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
    });
    const payload = await res.json();
    if (payload.success) {
      setMembersData(payload.data);
      setInviteEmail("");
    } else {
      setMemberError(payload.error ?? t("Could not invite member"));
    }
    setBusy(null);
  }

  async function removeInvitation(invitationId: string) {
    setBusy(`invite:${invitationId}`);
    await fetch("/api/workspace/members", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invitationId }),
    });
    await refreshMembers();
    setBusy(null);
  }

  if (loading) {
    return <div className="panel rounded p-8 h-64" />;
  }

  const accounts = data?.instagramAccounts ?? [];
  const canManageMembers =
    membersData?.currentUserRole === "OWNER" ||
    membersData?.currentUserRole === "ADMIN";

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      {/* Surfaces the ?instagram= code the OAuth routes redirect back with.
          Needs a Suspense boundary: useSearchParams in a prerendered client
          page fails the production build without one. */}
      <Suspense fallback={null}>
        <MetaConnectNotice />
      </Suspense>

      <section className="panel rounded p-4 sm:p-6 space-y-3">
        <h2 className="text-base font-semibold">{t("Interface language")}</h2>
        <LanguageSwitcher />
        <p className="text-sm text-muted">{t("Saved in this browser. Campaign messages stay unchanged.")}</p>
      </section>

      <ZernioConnection canManage={canManageMembers} />

      <section className="panel rounded p-4 sm:p-6">
        <h2 className="text-base font-semibold mb-2">{t("Instagram Connection")}</h2>
        <p className="mb-6 text-sm text-muted">
          {t("Connect an Instagram professional account to launch campaigns.")}
        </p>

        <div className="space-y-3">
          {accounts.map((account) => (
            <div
              key={account.id}
              className="flex flex-col gap-3 rounded border border-border bg-surface/70 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <p className="text-sm font-semibold text-foreground">
                  @{account.username}
                </p>
                <p className="mt-1 text-xs text-muted">
                  {account.provider === "ZERNIO" ? (
                    t("Connected via Zernio")
                  ) : (
                    <>
                      {t("Token expires")}{" "}
                      {account.tokenExpiresAt
                        ? new Date(account.tokenExpiresAt).toLocaleDateString(
                            locale
                          )
                        : t("not available")}
                    </>
                  )}{" "}
                  ·{" "}
                  {account.webhookSubscribed
                    ? t("Webhook ready")
                    : t("Webhook pending")}
                </p>
              </div>
              <button
                onClick={() => disconnectInstagram(account.id)}
                disabled={busy === `disconnect:${account.id}`}
                className="inline-flex items-center justify-center rounded border border-error/20 px-4 py-2 text-sm font-medium text-error transition-all hover:border-error/40 hover:bg-error/10 disabled:opacity-50"
              >
                {busy === `disconnect:${account.id}`
                  ? t("Disconnecting...")
                  : t("Disconnect")}
              </button>
            </div>
          ))}
        </div>

        {canManageMembers ? (
          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
            <a
              href="/api/instagram/connect"
              className="inline-flex items-center justify-center rounded bg-accent px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent-hover"
            >
              {t("Connect Instagram")}
            </a>
            <p className="text-xs text-muted">
              {t("One click opens Meta login and links the Instagram account.")}
            </p>
          </div>
        ) : null}

        {canManageMembers ? (
          <div className="mt-6 space-y-3 rounded border border-accent/30 bg-accent/5 p-4">
            <h3 className="text-sm font-semibold text-foreground">
              {t("Recommended: connect with System User token")}
            </h3>
            <p className="text-xs leading-relaxed text-muted">
              {t(
                "Paste a System User token from Meta Business Settings. If several Instagram accounts are on the token, pick which ones to connect (for example Nama)."
              )}
            </p>
            <textarea
              value={systemUserToken}
              onChange={(event) => {
                setSystemUserToken(event.target.value);
                setInstagramChoices([]);
                setSelectedInstagramIds([]);
              }}
              rows={3}
              placeholder={t("Paste System User access token")}
              className="w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
            {instagramChoices.length > 0 ? (
              <div className="space-y-2 rounded border border-border bg-background/80 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  {t("Select Instagram accounts")}
                </p>
                {instagramChoices.map((account) => (
                  <label
                    key={account.id}
                    className="flex items-center gap-2 text-sm text-foreground"
                  >
                    <input
                      type="checkbox"
                      checked={selectedInstagramIds.includes(account.id)}
                      onChange={() =>
                        setSelectedInstagramIds((prev) =>
                          toggleId(prev, account.id)
                        )
                      }
                    />
                    <span>
                      @{account.username}
                      {account.name ? ` · ${account.name}` : ""}
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <input
                value={systemUserIgId}
                onChange={(event) => setSystemUserIgId(event.target.value)}
                placeholder={t("Instagram account ID (optional)")}
                className="w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground"
              />
            )}
            {tokenConnectError ? (
              <p className="text-sm text-error">{tokenConnectError}</p>
            ) : null}
            {tokenConnectOk ? (
              <p className="text-sm text-accent">{tokenConnectOk}</p>
            ) : null}
            <button
              type="button"
              disabled={
                busy === "token-connect" ||
                !systemUserToken.trim() ||
                (instagramChoices.length > 0 && selectedInstagramIds.length === 0)
              }
              onClick={() =>
                void connectWithSystemUserToken(
                  instagramChoices.length > 0 ? selectedInstagramIds : undefined
                )
              }
              className="rounded bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {busy === "token-connect"
                ? t("Connecting...")
                : instagramChoices.length > 0
                  ? t("Connect selected Instagram accounts")
                  : t("Save System User token")}
            </button>
          </div>
        ) : null}
      </section>

      <section className="panel rounded p-4 sm:p-6">
        <h2 className="text-base font-semibold mb-2">
          {t("Facebook Pages")}
        </h2>
        <p className="mb-6 text-sm text-muted">
          {t(
            "Connect Facebook Pages with one click. Log in with Meta and grant the Pages you manage."
          )}
        </p>

        <div className="space-y-3">
          {facebookPages.length === 0 ? (
            <p className="text-sm text-muted">
              {t("No Facebook Page connected yet.")}
            </p>
          ) : null}
          {facebookPages.map((page) => (
            <div
              key={page.id}
              className="flex flex-col gap-3 rounded border border-border bg-surface/70 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <p className="text-sm font-semibold text-foreground">
                  {page.name}
                </p>
                <p className="mt-1 text-xs text-muted">
                  ID {page.pageId} ·{" "}
                  {page.webhookSubscribed
                    ? t("Page webhook ready")
                    : t("Page webhook pending")}
                </p>
              </div>
              <button
                onClick={() => disconnectFacebookPage(page.id)}
                disabled={busy === `fb-disconnect:${page.id}`}
                className="inline-flex items-center justify-center rounded border border-error/20 px-4 py-2 text-sm font-medium text-error transition-all hover:border-error/40 hover:bg-error/10 disabled:opacity-50"
              >
                {busy === `fb-disconnect:${page.id}`
                  ? t("Disconnecting...")
                  : t("Disconnect")}
              </button>
            </div>
          ))}
        </div>

        {canManageMembers ? (
          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
            <a
              href="/api/facebook/connect"
              className="inline-flex items-center justify-center rounded bg-accent px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent-hover"
            >
              {t("Connect Facebook")}
            </a>
            <p className="text-xs text-muted">
              {t(
                "One click connects every Page this Meta login can manage. Disconnect any you do not need."
              )}
            </p>
          </div>
        ) : null}

        {canManageMembers ? (
          <div className="mt-6 space-y-3 rounded border border-accent/30 bg-accent/5 p-4">
            <h3 className="text-sm font-semibold text-foreground">
              {t("Recommended: connect Facebook with System User token")}
            </h3>
            <p className="text-xs leading-relaxed text-muted">
              {t(
                "Paste the same System User token. If several Pages are on it, pick which ones to connect (for example Nama Production)."
              )}
            </p>
            <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-foreground">
              <p className="font-semibold">
                {t("Public reply under Facebook comments needs this permission")}
              </p>
              <p className="mt-1 text-muted">
                {t(
                  "When generating the System User token, tick pages_manage_engagement (plus pages_messaging, pages_read_engagement, pages_read_user_content). Without pages_manage_engagement, Messenger DMs can work but the public comment reply will fail with error #200."
                )}
              </p>
            </div>
            <textarea
              value={facebookToken}
              onChange={(event) => {
                setFacebookToken(event.target.value);
                setFacebookChoices([]);
                setSelectedFacebookPageIds([]);
              }}
              rows={3}
              placeholder={t("Paste System User or Page access token")}
              className="w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
            {facebookChoices.length > 0 ? (
              <div className="space-y-2 rounded border border-border bg-background/80 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  {t("Select Facebook Pages")}
                </p>
                {facebookChoices.map((page) => (
                  <label
                    key={page.id}
                    className="flex items-center gap-2 text-sm text-foreground"
                  >
                    <input
                      type="checkbox"
                      checked={selectedFacebookPageIds.includes(page.id)}
                      onChange={() =>
                        setSelectedFacebookPageIds((prev) =>
                          toggleId(prev, page.id)
                        )
                      }
                    />
                    <span>
                      {page.name} · {page.id}
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <input
                value={facebookPageId}
                onChange={(event) => setFacebookPageId(event.target.value)}
                placeholder={t("Facebook Page ID (optional)")}
                className="w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground"
              />
            )}
            {facebookConnectError ? (
              <p className="text-sm text-error">{facebookConnectError}</p>
            ) : null}
            {facebookConnectOk ? (
              <p className="text-sm text-accent">{facebookConnectOk}</p>
            ) : null}
            <button
              type="button"
              disabled={
                busy === "fb-token-connect" ||
                !facebookToken.trim() ||
                (facebookChoices.length > 0 &&
                  selectedFacebookPageIds.length === 0)
              }
              onClick={() =>
                void connectFacebookWithToken(
                  facebookChoices.length > 0
                    ? selectedFacebookPageIds
                    : undefined
                )
              }
              className="rounded bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {busy === "fb-token-connect"
                ? t("Connecting...")
                : facebookChoices.length > 0
                  ? t("Connect selected Facebook Pages")
                  : t("Save Facebook Page token")}
            </button>
          </div>
        ) : null}
      </section>

      <section className="panel rounded p-4 sm:p-6">
        <h2 className="text-base font-semibold mb-6">{t("Team")}</h2>
        <div className="space-y-3">
          {membersData?.members.map((member) => (
            <div
              key={member.id}
              className="flex items-center justify-between gap-4 border-b border-border py-3 last:border-0"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  {member.user.name ?? member.user.email ?? t("Unknown member")}
                </p>
                <p className="text-xs text-muted">{member.user.email}</p>
              </div>
              <span className="rounded-full border border-border px-3 py-1 text-xs font-semibold text-muted">
                {label(member.role)}
              </span>
            </div>
          ))}
        </div>

        {membersData?.invitations.length ? (
          <div className="mt-6 border-t border-border pt-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              {t("Pending invites")}
            </p>
            <div className="space-y-3">
              {membersData.invitations.map((invitation) => (
                <div
                  key={invitation.id}
                  className="flex flex-col gap-3 rounded border border-border bg-surface/70 p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {invitation.email}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {label(invitation.role)} · {invitation.inviteUrl}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        void navigator.clipboard?.writeText(invitation.inviteUrl)
                      }
                      className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-border-hover hover:text-foreground"
                    >
                      {t("Copy")}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeInvitation(invitation.id)}
                      disabled={busy === `invite:${invitation.id}`}
                      className="rounded-lg border border-error/20 px-3 py-1.5 text-xs font-medium text-error transition-colors hover:bg-error/10 disabled:opacity-50"
                    >
                      {t("Revoke")}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {canManageMembers && (
          <form
            onSubmit={inviteMember}
            className="mt-6 grid gap-3 border-t border-border pt-4 sm:grid-cols-[1fr_140px_auto]"
          >
            <input
              type="email"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              placeholder="teammate@agency.com"
              className="rounded border border-border bg-surface px-4 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40"
              required
            />
            <select
              value={inviteRole}
              onChange={(event) =>
                setInviteRole(event.target.value as "ADMIN" | "MEMBER")
              }
              className="rounded border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40"
            >
              <option value="MEMBER">{t("Member")}</option>
              <option value="ADMIN">{t("Admin")}</option>
            </select>
            <button
              type="submit"
              disabled={busy === "invite"}
              className="rounded bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {busy === "invite" ? t("Inviting...") : t("Invite")}
            </button>
            {memberError && (
              <p className="sm:col-span-3 text-sm text-error">{memberError}</p>
            )}
          </form>
        )}
      </section>

      <section className="panel rounded p-4 sm:p-6">
        <h2 className="text-base font-semibold mb-6">{t("Usage")}</h2>
        <div className="flex items-center justify-between gap-3 py-3">
          <div>
            <p className="text-sm font-medium text-foreground">
              {t("DMs sent this month")}
            </p>
            <p className="text-xs text-muted mt-0.5">
              {t("Self-hosted — no plan limits.")}
            </p>
          </div>
          <span className="text-sm font-semibold text-foreground">
            {data?.workspace.dmsSentThisPeriod ?? 0}
          </span>
        </div>
      </section>
    </div>
  );
}
