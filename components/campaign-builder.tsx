"use client";

/**
 * Campaign Builder
 *
 * Two-pane campaign editor: a control panel on the left and a live phone
 * preview on the right. Used for both creating and editing a campaign.
 *
 * Turn 1 wires the fully-functional pieces: trigger scope (specific / any /
 * next post), match mode (specific words / any word), the opening + reveal DM
 * text, public reply, and the tracked link. Button-driven delivery and the
 * follow / email / follow-up steps arrive in later turns.
 */

import { useI18n } from "@/lib/i18n/provider";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { type AccountOption } from "@/components/account-select";
import PostPicker from "@/components/post-picker";
import CampaignPreview, { type PreviewTab } from "@/components/campaign-preview";
import { readCache, writeCache } from "@/lib/client-cache";
import {
  IMPORT_QUEUE_KEY,
  IMPORT_ACCOUNT_KEY,
  type ImportRow,
} from "@/lib/import-queue";

type TriggerScope = "specific" | "any" | "next";
type MatchMode = "specific" | "any";

type CampaignChannel = "instagram" | "facebook";
type ChannelFilter = "instagram" | "facebook" | "all";

type UnifiedPageOption =
  | { key: string; channel: "instagram"; id: string; label: string }
  | { key: string; channel: "facebook"; id: string; label: string };

interface FacebookPageOption {
  id: string;
  pageId: string;
  name: string;
}

interface LoadedCampaign {
  id: string;
  name: string;
  postId: string | null;
  postUrl: string | null;
  pendingNextReel: boolean;
  matchAnyPost: boolean;
  keywords: string[];
  matchAnyWord: boolean;
  wholeWordMatch?: boolean;
  dmTriggerEnabled: boolean;
  dmMessage: string;
  openingDmEnabled: boolean;
  openingDmMessage: string | null;
  openingDmButtonLabel: string | null;
  linkButtonLabel: string | null;
  requireFollow: boolean;
  followPromptMessage: string | null;
  followPromptButtonLabel: string | null;
  followUpEnabled: boolean;
  followUpMessage: string | null;
  followUpDelayMinutes: number | null;
  publicReplyEnabled: boolean;
  publicReplyMessage: string | null;
  publicReplyMessages: string[];
  isActive: boolean;
  instagramAccountId: string | null;
  facebookPageId?: string | null;
  facebookPage?: FacebookPageOption | null;
  trackedLinks?: { destinationUrl: string; label?: string | null }[];
}

interface CampaignBuilderProps {
  mode: "new" | "edit";
  campaignId?: string;
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {children}
    </div>
  );
}

function Radio({
  checked,
  onSelect,
  children,
}: {
  checked: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${
        checked ? "border-accent bg-accent/5" : "border-border hover:border-border-hover"
      }`}
    >
      <span
        className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${
          checked ? "border-accent" : "border-zinc-500"
        }`}
      >
        {checked && <span className="h-2 w-2 rounded-full bg-accent" />}
      </span>
      <span className="flex-1 text-foreground">{children}</span>
    </button>
  );
}

function Toggle({
  on,
  onToggle,
}: {
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
        on ? "bg-accent" : "bg-zinc-300"
      }`}
    >
      <span
        className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-transform ${
          on ? "left-6" : "left-1"
        }`}
      />
    </button>
  );
}

export default function CampaignBuilder({ mode, campaignId }: CampaignBuilderProps) {
  const { t } = useI18n();
  const router = useRouter();

  const [loading, setLoading] = useState(mode === "edit");
  const [notFound, setNotFound] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [channel, setChannel] = useState<CampaignChannel>("instagram");
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>("all");
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [facebookPages, setFacebookPages] = useState<FacebookPageOption[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [selectedFacebookPageId, setSelectedFacebookPageId] = useState("");

  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [isActive, setIsActive] = useState(true);

  const [triggerScope, setTriggerScope] = useState<TriggerScope>("specific");
  const [postId, setPostId] = useState<string | null>(null);
  const [postUrl, setPostUrl] = useState<string | null>(null);
  const [postThumb, setPostThumb] = useState<string | null>(null);
  const [postCaption, setPostCaption] = useState("");
  // Dual-channel (All): separate post picks; shared keywords/DM below.
  const [facebookPostId, setFacebookPostId] = useState<string | null>(null);
  const [facebookPostUrl, setFacebookPostUrl] = useState<string | null>(null);
  const [instagramPostId, setInstagramPostId] = useState<string | null>(null);
  const [instagramPostUrl, setInstagramPostUrl] = useState<string | null>(null);

  const bothChannels = channelFilter === "all";

  // Post IDs already tied to another automation on this account, so the picker
  // can flag them and the user knows not to double-assign. Maps postId ->
  // the campaign name using it (for the tooltip).
  const [usedPosts, setUsedPosts] = useState<Record<string, string>>({});

  const [matchMode, setMatchMode] = useState<MatchMode>("specific");
  const [keywordText, setKeywordText] = useState("");
  const [wholeWordMatch, setWholeWordMatch] = useState(true);
  const [dmTriggerEnabled, setDmTriggerEnabled] = useState(false);

  const [publicReplyEnabled, setPublicReplyEnabled] = useState(true);
  const [publicReplyMessages, setPublicReplyMessages] = useState<string[]>([
    "تشکر از کامنت زیبای‌تان؛ جزئیات برای‌تان ارسال شد.",
  ]);

  const [openingDmEnabled, setOpeningDmEnabled] = useState(false);
  const [openingDmMessage, setOpeningDmMessage] = useState("");
  const [openingDmButtonLabel, setOpeningDmButtonLabel] = useState("");

  const [dmMessage, setDmMessage] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [trackedDestinationUrl, setTrackedDestinationUrl] = useState("");
  const [linkButtonLabel, setLinkButtonLabel] = useState("Open link");
  const [secondLinkOpen, setSecondLinkOpen] = useState(false);
  const [secondaryDestinationUrl, setSecondaryDestinationUrl] = useState("");
  const [secondaryButtonLabel, setSecondaryButtonLabel] = useState("Open link");
  const [requireFollow, setRequireFollow] = useState(false);
  const [followPromptMessage, setFollowPromptMessage] = useState("");
  const [followPromptButtonLabel, setFollowPromptButtonLabel] =
    useState("i'm following");
  const [followUpEnabled, setFollowUpEnabled] = useState(false);
  const [followUpMessage, setFollowUpMessage] = useState("");
  const [followUpDelayMinutes, setFollowUpDelayMinutes] = useState(0);

  const [previewTab, setPreviewTab] = useState<PreviewTab>("dm");

  // CSV import queue. When present, each save advances to the next row instead
  // of returning to the campaigns list.
  const [importQueue, setImportQueue] = useState<ImportRow[] | null>(null);
  const [importTotal, setImportTotal] = useState(0);

  const keywords = useMemo(
    () =>
      keywordText
        // Comma or whitespace both split — "لینک link" and "لینک, link" work.
        .split(/[,\s]+/u)
        .map((k) => k.trim())
        .filter(Boolean),
    [keywordText]
  );

  // Fetch the connected account's real avatar for the preview (cache-first so
  // it shows instantly on a return visit instead of a blank circle).
  useEffect(() => {
    if (channel !== "instagram" || !selectedAccountId) {
      setAvatarUrl(null);
      return;
    }
    let cancelled = false;
    const cacheKey = `ig-avatar:${selectedAccountId}`;
    const cached = readCache<string | null>(cacheKey, 30 * 60 * 1000);
    // Hydrating state from cache is a legitimate effect use here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (cached.data !== null) setAvatarUrl(cached.data);

    const params = new URLSearchParams({ instagramAccountId: selectedAccountId });
    fetch(`/api/instagram/profile?${params}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const url = d.success ? d.data.profilePictureUrl ?? null : null;
        setAvatarUrl(url);
        writeCache(cacheKey, url);
      })
      .catch(() => {
        if (!cancelled && cached.data === null) setAvatarUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [channel, selectedAccountId]);

  // Load IG accounts + Facebook Pages for the channel selector.
  useEffect(() => {
    fetch("/api/dashboard/stats")
      .then(async (r) => {
        const text = await r.text();
        if (!text) return null;
        try {
          return JSON.parse(text) as {
            success?: boolean;
            data?: {
              instagramAccounts?: AccountOption[];
              facebookPages?: FacebookPageOption[];
              selectedInstagramAccountId?: string;
            };
          };
        } catch {
          return null;
        }
      })
      .then((payload) => {
        if (!payload?.success || !payload.data) return;
        const next: AccountOption[] = payload.data.instagramAccounts ?? [];
        const pages: FacebookPageOption[] = payload.data.facebookPages ?? [];
        setAccounts(next);
        setFacebookPages(pages);
        setSelectedAccountId(
          (prev) =>
            prev ||
            payload.data?.selectedInstagramAccountId ||
            next[0]?.id ||
            ""
        );
        setSelectedFacebookPageId((prev) => prev || pages[0]?.id || "");
        // v2 may only have a Facebook Page connected — default the builder there.
        if (next.length === 0 && pages.length > 0) {
          setChannel("facebook");
          setChannelFilter("facebook");
        }
      })
      .catch(() => {
        setAccounts([]);
        setFacebookPages([]);
      });
  }, []);

  // Prefill when editing.
  useEffect(() => {
    if (mode !== "edit" || !campaignId) return;
    fetch("/api/automations", { cache: "no-store" })
      .then((r) => r.json())
      .then((payload) => {
        if (!payload.success) return setNotFound(true);
        const c = (payload.data as LoadedCampaign[]).find((x) => x.id === campaignId);
        if (!c) return setNotFound(true);
        setName(c.name);
        if (c.facebookPageId) {
          setChannel("facebook");
          setChannelFilter("facebook");
          setSelectedFacebookPageId(c.facebookPageId);
        } else {
          setChannel("instagram");
          setChannelFilter("instagram");
          setSelectedAccountId(c.instagramAccountId ?? "");
        }
        setTriggerScope(
          c.matchAnyPost ? "any" : c.pendingNextReel ? "next" : "specific"
        );
        setPostId(c.postId);
        setPostUrl(c.postUrl);
        setMatchMode(c.matchAnyWord ? "any" : "specific");
        setKeywordText(c.keywords.join(", "));
        setWholeWordMatch(c.wholeWordMatch ?? true);
        setDmTriggerEnabled(c.dmTriggerEnabled ?? false);
        setPublicReplyEnabled(c.publicReplyEnabled);
        setPublicReplyMessages(
          c.publicReplyMessages?.length
            ? c.publicReplyMessages
            : c.publicReplyMessage
              ? [c.publicReplyMessage]
              : [""]
        );
        setOpeningDmEnabled(c.openingDmEnabled);
        setOpeningDmMessage(c.openingDmMessage ?? "");
        setOpeningDmButtonLabel(c.openingDmButtonLabel ?? "");
        setDmMessage(c.dmMessage);
        setLinkButtonLabel(c.linkButtonLabel ?? "Open link");
        setIsActive(c.isActive);
        const link = c.trackedLinks?.[0]?.destinationUrl ?? "";
        setTrackedDestinationUrl(link);
        setLinkOpen(Boolean(link));
        const secondLink = c.trackedLinks?.[1];
        setSecondaryDestinationUrl(secondLink?.destinationUrl ?? "");
        setSecondaryButtonLabel(secondLink?.label ?? "Open link");
        setSecondLinkOpen(Boolean(secondLink?.destinationUrl));
        setRequireFollow(c.requireFollow ?? false);
        setFollowPromptMessage(c.followPromptMessage ?? "");
        setFollowPromptButtonLabel(
          c.followPromptButtonLabel ?? "i'm following"
        );
        setFollowUpEnabled(c.followUpEnabled ?? false);
        setFollowUpMessage(c.followUpMessage ?? "");
        setFollowUpDelayMinutes(c.followUpDelayMinutes ?? 0);
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [mode, campaignId]);

  // Track which posts on the selected account are already assigned to an
  // automation, so the picker can highlight them. The campaign being edited is
  // excluded — its own post should read as selected, not "taken".
  useEffect(() => {
    const scopeId =
      channel === "facebook" ? selectedFacebookPageId : selectedAccountId;
    if (!scopeId) return;
    let cancelled = false;
    fetch("/api/automations", { cache: "no-store" })
      .then((r) => r.json())
      .then((payload) => {
        if (cancelled || !payload.success) return;
        const map: Record<string, string> = {};
        for (const a of payload.data as LoadedCampaign[]) {
          if (!a.postId) continue;
          if (channel === "facebook") {
            if (a.facebookPageId !== scopeId) continue;
          } else if (a.instagramAccountId !== scopeId) {
            continue;
          }
          if (mode === "edit" && a.id === campaignId) continue;
          map[a.postId] = a.name;
        }
        setUsedPosts(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [
    channel,
    selectedAccountId,
    selectedFacebookPageId,
    mode,
    campaignId,
  ]);

  // Prefill the editable fields from one queued import row. The reel is left
  // unset so the user picks it per row.
  function prefillFromRow(row: ImportRow) {
    setName(row.name ?? "");
    setTriggerScope("specific");
    setPostId(null);
    setPostUrl(null);
    setPostThumb(null);
    setPostCaption("");
    setMatchMode("specific");
    setKeywordText((row.keywords ?? []).join(", "));
    setDmMessage(row.dmMessage ?? "");
    setPublicReplyEnabled(Boolean(row.publicReply));
    setPublicReplyMessages(row.publicReply ? [row.publicReply] : [""]);
    const hasOpening = Boolean(row.openingDmMessage);
    setOpeningDmEnabled(hasOpening);
    setOpeningDmMessage(row.openingDmMessage ?? "");
    setOpeningDmButtonLabel(
      row.openingDmButtonLabel || (hasOpening ? "Send link" : "")
    );
    const link = row.trackedUrl ?? "";
    setTrackedDestinationUrl(link);
    setLinkOpen(Boolean(link));
    setError(null);
  }

  // Pick up a staged CSV import (new mode only) and prefill the first row.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (mode !== "new") return;
    try {
      const raw = window.localStorage.getItem(IMPORT_QUEUE_KEY);
      const acct = window.localStorage.getItem(IMPORT_ACCOUNT_KEY);
      if (!raw) return;
      const queue = JSON.parse(raw) as ImportRow[];
      if (!Array.isArray(queue) || queue.length === 0) return;
      setImportQueue(queue);
      setImportTotal(queue.length);
      if (acct) setSelectedAccountId(acct);
      prefillFromRow(queue[0]);
    } catch {
      // ignore a malformed queue
    }
  }, [mode]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const unifiedPages = useMemo<UnifiedPageOption[]>(() => {
    const ig: UnifiedPageOption[] = accounts.map((a) => ({
      key: `instagram:${a.id}`,
      channel: "instagram",
      id: a.id,
      label: `Instagram · @${a.username}`,
    }));
    const fb: UnifiedPageOption[] = facebookPages.map((p) => ({
      key: `facebook:${p.id}`,
      channel: "facebook",
      id: p.id,
      label: `Facebook · ${p.name}`,
    }));
    if (channelFilter === "instagram") return ig;
    if (channelFilter === "facebook") return fb;
    return [...ig, ...fb];
  }, [accounts, facebookPages, channelFilter]);

  const selectedUnifiedKey =
    channel === "facebook"
      ? selectedFacebookPageId
        ? `facebook:${selectedFacebookPageId}`
        : ""
      : selectedAccountId
        ? `instagram:${selectedAccountId}`
        : "";

  // Keep selection valid when the channel filter changes.
  useEffect(() => {
    if (unifiedPages.length === 0) return;
    if (unifiedPages.some((p) => p.key === selectedUnifiedKey)) return;
    const first = unifiedPages[0];
    if (!first) return;
    if (first.channel === "facebook") {
      setChannel("facebook");
      setSelectedFacebookPageId(first.id);
    } else {
      setChannel("instagram");
      setSelectedAccountId(first.id);
    }
  }, [unifiedPages, selectedUnifiedKey]);

  function selectUnifiedPage(key: string) {
    const option = unifiedPages.find((p) => p.key === key);
    if (!option) return;
    setPostId(null);
    setPostUrl(null);
    setPostThumb(null);
    if (option.channel === "facebook") {
      setChannel("facebook");
      setSelectedFacebookPageId(option.id);
      setOpeningDmEnabled(false);
      setRequireFollow(false);
      setDmTriggerEnabled(false);
      if (triggerScope === "next") setTriggerScope("specific");
    } else {
      setChannel("instagram");
      setSelectedAccountId(option.id);
    }
  }

  const username =
    channel === "facebook"
      ? facebookPages.find((p) => p.id === selectedFacebookPageId)?.name ??
        "Facebook Page"
      : accounts.find((a) => a.id === selectedAccountId)?.username ?? "yourbrand";

  function handlePostSelect(
    id: string | null,
    url?: string,
    thumb?: string,
    caption?: string
  ) {
    if (!id) {
      setPostId(null);
      setPostUrl(null);
      setPostThumb(null);
      setPostCaption("");
      return;
    }
    setPostId(id);
    setPostUrl(url ?? null);
    setPostThumb(thumb ?? null);
    setPostCaption(caption ?? "");
  }

  function handleFacebookPostSelect(
    id: string | null,
    url?: string,
    thumb?: string,
    caption?: string
  ) {
    if (!id) {
      setFacebookPostId(null);
      setFacebookPostUrl(null);
      if (!bothChannels) handlePostSelect(null);
      else {
        setPostThumb(null);
        setPostCaption("");
      }
      return;
    }
    setFacebookPostId(id);
    setFacebookPostUrl(url ?? null);
    if (bothChannels) {
      setPostThumb(thumb ?? null);
      setPostCaption(caption ?? "");
    } else {
      handlePostSelect(id, url, thumb, caption);
    }
  }

  function handleInstagramPostSelect(
    id: string | null,
    url?: string,
    thumb?: string,
    caption?: string
  ) {
    if (!id) {
      setInstagramPostId(null);
      setInstagramPostUrl(null);
      if (!bothChannels) handlePostSelect(null);
      else {
        setPostThumb(null);
        setPostCaption("");
      }
      return;
    }
    setInstagramPostId(id);
    setInstagramPostUrl(url ?? null);
    if (bothChannels) {
      setPostThumb(thumb ?? null);
      setPostCaption(caption ?? "");
    } else {
      handlePostSelect(id, url, thumb, caption);
    }
  }

  function clearPostPicks() {
    setPostId(null);
    setPostUrl(null);
    setPostThumb(null);
    setPostCaption("");
    setFacebookPostId(null);
    setFacebookPostUrl(null);
    setInstagramPostId(null);
    setInstagramPostUrl(null);
  }

  function pairInstagramForFacebook(facebookPageDbId: string) {
    const page = facebookPages.find((p) => p.id === facebookPageDbId);
    if (!page || accounts.length === 0) return;
    const hay = page.name.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const match =
      accounts.find((a) => {
        const u = a.username.toLowerCase().replace(/[^a-z0-9]+/g, "");
        return hay.includes(u) || u.includes(hay.slice(0, 8));
      }) ??
      accounts.find((a) =>
        page.name.toLowerCase().includes(a.username.toLowerCase().split(/[._]/)[0] ?? "")
      );
    if (match) setSelectedAccountId(match.id);
  }

  function ensureLinkToken() {
    setDmMessage((cur) => (cur.includes("{link}") ? cur : `${cur.trim()} {link}`.trim()));
  }

  function buildPayload(opts: {
    activeValue: boolean;
    channel: CampaignChannel;
    campaignName: string;
    postIdValue: string | null;
    postUrlValue: string | null;
  }) {
    const isFacebook = opts.channel === "facebook";
    // Dual Both campaigns always send the main DM directly on both channels.
    // Opening DM / follow gate are Instagram-only extras and stay off for twins.
    const allowIgExtras = !isFacebook && !bothChannels;
    return {
      name: opts.campaignName,
      channel: opts.channel,
      instagramAccountId: isFacebook ? null : selectedAccountId,
      facebookPageId: isFacebook ? selectedFacebookPageId : null,
      postId: triggerScope === "specific" ? opts.postIdValue : null,
      postUrl: triggerScope === "specific" ? opts.postUrlValue : null,
      matchAnyPost: triggerScope === "any",
      pendingNextReel: isFacebook ? false : triggerScope === "next",
      matchAnyWord: matchMode === "any",
      keywords: matchMode === "any" ? [] : keywords,
      wholeWordMatch,
      dmTriggerEnabled: allowIgExtras ? dmTriggerEnabled : false,
      dmMessage,
      openingDmEnabled: allowIgExtras ? openingDmEnabled : false,
      openingDmMessage:
        allowIgExtras && openingDmEnabled ? openingDmMessage : null,
      openingDmButtonLabel:
        allowIgExtras && openingDmEnabled ? openingDmButtonLabel : null,
      publicReplyEnabled,
      publicReplyMessages: publicReplyEnabled
        ? publicReplyMessages.map((m) => m.trim()).filter(Boolean)
        : [],
      trackedDestinationUrl: trackedDestinationUrl.trim() || "",
      linkButtonLabel: linkButtonLabel.trim() || "Open link",
      secondaryDestinationUrl: secondaryDestinationUrl.trim() || "",
      secondaryButtonLabel: secondaryButtonLabel.trim() || "Open link",
      requireFollow: allowIgExtras ? requireFollow : false,
      followPromptMessage:
        allowIgExtras && requireFollow ? followPromptMessage.trim() : "",
      followPromptButtonLabel:
        allowIgExtras && requireFollow
          ? followPromptButtonLabel.trim() || "i'm following"
          : "",
      followUpEnabled,
      followUpMessage: followUpEnabled ? followUpMessage.trim() : "",
      followUpDelayMinutes: followUpEnabled ? followUpDelayMinutes : 0,
      isActive: opts.activeValue,
    };
  }

  async function postAutomation(payload: ReturnType<typeof buildPayload>) {
    const res =
      mode === "new"
        ? await fetch("/api/automations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch(`/api/automations?id=${campaignId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
    const raw = await res.text();
    let data: {
      success?: boolean;
      error?: string;
      message?: string;
      details?: { fieldErrors?: Record<string, string[]> };
    } = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error(
        `Save failed (HTTP ${res.status}). Server returned an empty/invalid response.`
      );
    }
    if (!data.success) {
      const fieldErrors = data.details?.fieldErrors
        ? Object.entries(data.details.fieldErrors)
            .flatMap(([k, v]) => v.map((msg) => `${k}: ${msg}`))
            .join(" · ")
        : "";
      throw new Error(
        data.message || data.error || fieldErrors || t("Could not save campaign")
      );
    }
    return data;
  }

  async function handleSubmit(activeValue: boolean) {
    setError(null);

    if (bothChannels) {
      if (!selectedFacebookPageId)
        return setError(t("Select a Facebook Page."));
      if (!selectedAccountId)
        return setError(t("Select an Instagram account."));
      if (triggerScope === "specific" && !facebookPostId)
        return setError(t("Pick a Facebook post."));
      if (triggerScope === "specific" && !instagramPostId)
        return setError(t("Pick an Instagram post or reel."));
      if (triggerScope === "next")
        return setError(t("Next-post targeting is Instagram-only. Use specific or any."));
    } else {
      if (channel === "instagram" && !selectedAccountId)
        return setError(t("Connect an Instagram account first."));
      if (channel === "facebook" && !selectedFacebookPageId)
        return setError("Connect a Facebook Page first.");
      if (triggerScope === "specific" && !postId)
        return setError(
          channel === "facebook"
            ? "Pick a Facebook post to trigger the campaign."
            : t("Pick a post or reel to trigger the campaign.")
        );
      if (channel === "facebook" && triggerScope === "next")
        return setError("Next-post targeting is Instagram-only.");
    }
    if (matchMode === "specific" && keywords.length === 0)
      return setError(t("Add at least one keyword, or switch to any word."));
    if (!dmMessage.trim()) return setError(t("Add the DM with the link."));
    if (
      publicReplyEnabled &&
      !publicReplyMessages.some((m) => m.trim())
    )
      return setError(t("Add a public reply under the comment, or turn the toggle off."));
    if (
      !bothChannels &&
      channel === "instagram" &&
      openingDmEnabled &&
      (!openingDmMessage.trim() || !openingDmButtonLabel.trim())
    )
      return setError(t("Your opening DM needs a message and a button label."));

    setSaving(true);

    const baseName =
      name.trim() ||
      (bothChannels
        ? t("Campaign for Facebook + Instagram")
        : `Campaign for @${username}`);

    try {
      if (bothChannels) {
        if (mode === "edit") {
          setError(
            t(
              "Editing a dual campaign is not supported here. Edit the Facebook and Instagram campaigns separately."
            )
          );
          setSaving(false);
          return;
        }
        const fbPayload = buildPayload({
          activeValue,
          channel: "facebook",
          campaignName: `${baseName} (Facebook)`,
          postIdValue: facebookPostId,
          postUrlValue: facebookPostUrl,
        });
        const igPayload = buildPayload({
          activeValue,
          channel: "instagram",
          campaignName: `${baseName} (Instagram)`,
          postIdValue: instagramPostId,
          postUrlValue: instagramPostUrl,
        });
        await postAutomation(fbPayload);
        await postAutomation(igPayload);
        if (facebookPostId)
          setUsedPosts((prev) => ({ ...prev, [facebookPostId]: fbPayload.name }));
        if (instagramPostId)
          setUsedPosts((prev) => ({
            ...prev,
            [instagramPostId]: igPayload.name,
          }));
        router.push("/campaigns");
        router.refresh();
        return;
      }

      const payload = buildPayload({
        activeValue,
        channel,
        campaignName: baseName,
        postIdValue: postId,
        postUrlValue: postUrl,
      });
      await postAutomation(payload);
      if (triggerScope === "specific" && postId) {
        setUsedPosts((prev) => ({ ...prev, [postId]: payload.name }));
      }
      if (importQueue && importQueue.length > 1) {
        const remaining = importQueue.slice(1);
        try {
          window.localStorage.setItem(
            IMPORT_QUEUE_KEY,
            JSON.stringify(remaining)
          );
        } catch {
          // ignore
        }
        setImportQueue(remaining);
        prefillFromRow(remaining[0]);
        setSaving(false);
        if (typeof window !== "undefined") window.scrollTo({ top: 0 });
        return;
      }
      if (importQueue) {
        try {
          window.localStorage.removeItem(IMPORT_QUEUE_KEY);
          window.localStorage.removeItem(IMPORT_ACCOUNT_KEY);
        } catch {
          // ignore
        }
      }
      router.push("/campaigns");
      router.refresh();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("Failed to save campaign")
      );
      if (typeof window !== "undefined")
        window.scrollTo({ top: 0, behavior: "smooth" });
    } finally {
      setSaving(false);
    }
  }

  // Skip the current imported row without saving a campaign for it, advancing
  // to the next one (or finishing the import if it was the last).
  function skipRow() {
    if (!importQueue) return;
    setError(null);
    if (importQueue.length > 1) {
      const remaining = importQueue.slice(1);
      try {
        window.localStorage.setItem(IMPORT_QUEUE_KEY, JSON.stringify(remaining));
      } catch {
        // ignore
      }
      setImportQueue(remaining);
      prefillFromRow(remaining[0]);
      if (typeof window !== "undefined") window.scrollTo({ top: 0 });
      return;
    }
    // Last row skipped — finish the import.
    try {
      window.localStorage.removeItem(IMPORT_QUEUE_KEY);
      window.localStorage.removeItem(IMPORT_ACCOUNT_KEY);
    } catch {
      // ignore
    }
    router.push("/campaigns");
    router.refresh();
  }

  if (loading) {
    return <div className="panel h-64 rounded" />;
  }

  if (notFound) {
    return (
      <div className="panel rounded p-8 text-center">
        <p className="text-sm text-muted">{t("Campaign not found.")}</p>
        <button
          onClick={() => router.push("/campaigns")}
          className="mt-4 rounded border border-border px-4 py-2 text-sm text-muted hover:text-foreground"
        >
          {t("Back to campaigns")}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {importQueue && (
        <div className="rounded border border-accent/30 bg-accent/5 px-4 py-3 text-sm">
          <span className="font-medium text-foreground">
            {t("Importing {current} of {total}.", { current: importTotal - importQueue.length + 1, total: importTotal })}
          </span>{" "}
          <span className="text-muted">
            {t("Fields are prefilled from your CSV. Pick the reel, edit anything, and save to load the next one — or Skip if you don’t want this one.")}
          </span>
        </div>
      )}

      {/* Top bar */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 items-center gap-3">
          {mode === "edit" ? (
            <>
              <span className="truncate text-sm font-semibold text-foreground">
                {name || t("Untitled campaign")}
              </span>
              <span
                className={`rounded px-2 py-0.5 text-xs font-semibold ${
                  isActive ? "bg-success/15 text-success" : "bg-zinc-500/15 text-muted"
                }`}
              >
                {isActive ? t("LIVE") : t("PAUSED")}
              </span>
            </>
          ) : (
            <span className="text-sm text-muted">{t("New campaign")}</span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {importQueue && (
            <button
              type="button"
              onClick={skipRow}
              disabled={saving}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted hover:text-foreground disabled:opacity-50"
            >
              {importQueue.length > 1 ? t("Skip") : t("Skip & finish")}
            </button>
          )}
          {mode === "edit" &&
            (isActive ? (
              <button
                type="button"
                onClick={() => handleSubmit(false)}
                disabled={saving}
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted hover:text-foreground disabled:opacity-50"
              >
                {t("Stop")}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => handleSubmit(true)}
                disabled={saving}
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted hover:text-foreground disabled:opacity-50"
              >
                {t("Go Live")}
              </button>
            ))}
          <button
            type="button"
            onClick={() => handleSubmit(mode === "new" ? true : isActive)}
            disabled={saving}
            className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {saving ? t("Saving…") : mode === "new" ? t("Go Live") : t("Save changes")}
          </button>
        </div>
      </div>

      {/* min-w-0 on the cells: a grid item defaults to min-width:auto, so a
          long string widens the whole page instead of wrapping. */}
      <div className="grid gap-6 lg:grid-cols-[300px_1fr] lg:gap-8">
      {/* Left: controls */}
      <div className="space-y-8 min-w-0">
        {error && (
          <div className="rounded border border-error/20 bg-error/10 p-3 text-sm text-error">
            {error}
          </div>
        )}

        <div className="space-y-3">
          <label className="text-sm font-semibold text-foreground">
            {t("Campaign name")}{" "}
            <span className="font-normal text-muted">{t("(optional)")}</span>
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("e.g. YC referral")}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
            maxLength={100}
          />
          <div className="space-y-2 pt-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              {t("Channel")}
            </p>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["all", t("Both (Facebook + Instagram)")],
                  ["instagram", "Instagram"],
                  ["facebook", "Facebook"],
                ] as const
              ).map(([value, labelText]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    setChannelFilter(value);
                    clearPostPicks();
                    if (value === "instagram") {
                      setChannel("instagram");
                      if (triggerScope === "next") setTriggerScope("specific");
                    } else if (value === "facebook") {
                      setChannel("facebook");
                      setOpeningDmEnabled(false);
                      setRequireFollow(false);
                      setDmTriggerEnabled(false);
                      if (triggerScope === "next") setTriggerScope("specific");
                    } else {
                      setOpeningDmEnabled(false);
                      setRequireFollow(false);
                      setDmTriggerEnabled(false);
                      if (triggerScope === "next") setTriggerScope("specific");
                      if (selectedFacebookPageId) {
                        pairInstagramForFacebook(selectedFacebookPageId);
                      }
                    }
                  }}
                  className={`rounded-lg border px-3 py-1.5 text-sm ${
                    channelFilter === value
                      ? "border-accent bg-accent/5 text-foreground"
                      : "border-border text-muted"
                  }`}
                >
                  {labelText}
                </button>
              ))}
            </div>
            {bothChannels ? (
              <p className="text-xs text-muted">
                {t(
                  "One form, two campaigns: pick a Facebook Page + post and an Instagram account + post. Keywords and DM stay the same."
                )}
              </p>
            ) : null}
          </div>

          {bothChannels ? (
            <div className="grid gap-3 pt-2 sm:grid-cols-2">
              <label className="flex flex-col gap-2 text-sm">
                <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  {t("Facebook Page")}
                </span>
                <select
                  value={selectedFacebookPageId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setSelectedFacebookPageId(id);
                    setFacebookPostId(null);
                    setFacebookPostUrl(null);
                    pairInstagramForFacebook(id);
                  }}
                  className="rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-accent/40"
                >
                  <option value="">{t("Select Facebook Page")}</option>
                  {facebookPages.map((page) => (
                    <option key={page.id} value={page.id}>
                      {page.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-2 text-sm">
                <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  {t("Instagram account")}
                </span>
                <select
                  value={selectedAccountId}
                  onChange={(e) => {
                    setSelectedAccountId(e.target.value);
                    setInstagramPostId(null);
                    setInstagramPostUrl(null);
                  }}
                  className="rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-accent/40"
                >
                  <option value="">{t("Select Instagram account")}</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      @{account.username}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : (
            <div className="pt-2">
              {unifiedPages.length === 0 ? (
                <p className="text-sm text-muted">
                  {t("No pages connected yet.")}{" "}
                  <a href="/settings" className="text-accent underline">
                    {t("Connect Instagram or Facebook in Settings")}
                  </a>
                </p>
              ) : (
                <label className="flex flex-col gap-2 text-sm">
                  <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                    {t("Page / account")}
                  </span>
                  <select
                    value={selectedUnifiedKey}
                    onChange={(e) => selectUnifiedPage(e.target.value)}
                    className="min-w-52 rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40"
                  >
                    <option value="" disabled>
                      {t("Select a page")}
                    </option>
                    {unifiedPages.map((page) => (
                      <option key={page.key} value={page.key}>
                        {page.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}
        </div>

        <Section title={t("When someone comments on")}>
          <Radio
            checked={triggerScope === "specific"}
            onSelect={() => setTriggerScope("specific")}
          >
            {bothChannels
              ? t("specific posts (Facebook + Instagram)")
              : channel === "facebook"
                ? t("a specific Facebook post")
                : t("a specific Instagram post or reel")}
          </Radio>
          {triggerScope === "specific" && bothChannels ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-border p-3">
                <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                  {t("Facebook post picker")}
                </div>
                <PostPicker
                  selectedPostId={facebookPostId}
                  channel="facebook"
                  facebookPageId={selectedFacebookPageId || null}
                  usedPostIds={usedPosts}
                  dense
                  onSelect={handleFacebookPostSelect}
                />
              </div>
              <div className="rounded-lg border border-border p-3">
                <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                  {t("Instagram post picker")}
                </div>
                <PostPicker
                  selectedPostId={instagramPostId}
                  channel="instagram"
                  instagramAccountId={selectedAccountId || null}
                  usedPostIds={usedPosts}
                  dense
                  onSelect={handleInstagramPostSelect}
                />
              </div>
            </div>
          ) : null}
          {triggerScope === "specific" && !bothChannels ? (
            <div className="rounded-lg border border-border p-2">
              <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                {channel === "facebook"
                  ? t("Facebook post picker")
                  : t("Instagram post picker")}
              </div>
              <PostPicker
                selectedPostId={postId}
                channel={channel}
                instagramAccountId={selectedAccountId}
                facebookPageId={selectedFacebookPageId}
                usedPostIds={usedPosts}
                onSelect={handlePostSelect}
              />
            </div>
          ) : null}
          <Radio
            checked={triggerScope === "any"}
            onSelect={() => setTriggerScope("any")}
          >
            {bothChannels
              ? t("any post on both channels")
              : channel === "facebook"
                ? t("any Facebook post")
                : t("any Instagram post or reel")}
          </Radio>
          {!bothChannels && channel === "instagram" ? (
            <Radio
              checked={triggerScope === "next"}
              onSelect={() => setTriggerScope("next")}
            >
              {t("next post or reel")}
            </Radio>
          ) : null}
        </Section>

        <Section title={t("And this comment has")}>
          <Radio
            checked={matchMode === "specific"}
            onSelect={() => setMatchMode("specific")}
          >
            {t("a specific word or words")}
          </Radio>
          {matchMode === "specific" && (
            <div className="space-y-1">
              <input
                value={keywordText}
                onChange={(e) => setKeywordText(e.target.value)}
                placeholder={t("Enter a word or multiple")}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
              />
              <p className="text-xs text-muted">{t("Use commas to separate words")}</p>
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
                <span className="text-sm text-foreground">{t("Match part of a word")}</span>
                <Toggle
                  on={!wholeWordMatch}
                  onToggle={() => setWholeWordMatch(!wholeWordMatch)}
                />
              </div>
              {!wholeWordMatch && (
                <p className="text-xs text-muted">
                  {t("Also fires when a keyword is part of a longer word, e.g. “link” in “links”.")}
                </p>
              )}
            </div>
          )}
          <Radio
            checked={matchMode === "any"}
            onSelect={() => setMatchMode("any")}
          >
            {t("any word")}
          </Radio>
          {!bothChannels && channel === "instagram" ? (
            <>
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
                <span className="text-sm text-foreground">
                  {t("also reply when someone DMs")}{" "}
                  {matchMode === "any" ? t("anything") : t("these words")}
                </span>
                <Toggle
                  on={dmTriggerEnabled}
                  onToggle={() => setDmTriggerEnabled(!dmTriggerEnabled)}
                />
              </div>
              {dmTriggerEnabled && (
                <p className="text-xs text-muted">
                  {matchMode === "any"
                    ? t("Every DM to this account gets the reply below — use with care.")
                    : t("A DM containing any of these words gets the same reply, no comment needed.")}
                </p>
              )}
            </>
          ) : null}

          <div className="space-y-2 rounded-lg border border-accent/30 bg-accent/5 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">
                  {t("Public reply under the post")}
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {t(
                    "When someone comments the keyword, reply publicly under that comment (Facebook + Instagram)."
                  )}
                </p>
              </div>
              <Toggle
                on={publicReplyEnabled}
                onToggle={() => {
                  const next = !publicReplyEnabled;
                  setPublicReplyEnabled(next);
                  if (
                    next &&
                    publicReplyMessages.every((m) => !m.trim())
                  ) {
                    setPublicReplyMessages([
                      "تشکر از کامنت زیبای‌تان؛ جزئیات برای‌تان ارسال شد.",
                    ]);
                  }
                }}
              />
            </div>
            {publicReplyEnabled && (
              <div className="space-y-2">
                {publicReplyMessages.map((msg, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <textarea
                      value={msg}
                      onChange={(e) =>
                        setPublicReplyMessages((prev) =>
                          prev.map((m, idx) => (idx === i ? e.target.value : m))
                        )
                      }
                      placeholder="تشکر از کامنت زیبای‌تان؛ جزئیات برای‌تان ارسال شد."
                      rows={2}
                      dir="auto"
                      maxLength={1000}
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm leading-6 text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none resize-y [unicode-bidi:plaintext]"
                    />
                    {publicReplyMessages.length > 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          setPublicReplyMessages((prev) =>
                            prev.filter((_, idx) => idx !== i)
                          )
                        }
                        className="shrink-0 px-2 pt-2 text-muted hover:text-error"
                        aria-label={t("Remove reply")}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
                {publicReplyMessages.length < 10 && (
                  <button
                    type="button"
                    onClick={() =>
                      setPublicReplyMessages((prev) => [...prev, ""])
                    }
                    className="text-xs font-medium text-accent hover:underline"
                  >
                    {t("+ Add another reply")}
                  </button>
                )}
                <p className="text-xs text-muted">
                  {t(
                    "One reply is picked at random each time so comments do not look identical."
                  )}
                </p>
              </div>
            )}
          </div>
        </Section>

        <Section
          title={
            bothChannels
              ? t("Direct message (Facebook + Instagram)")
              : channel === "facebook"
                ? t("Messenger message")
                : t("Instagram DM")
          }
        >
          <div className="space-y-2 rounded-lg border border-accent/30 bg-accent/5 p-3">
            <div>
              <p className="text-sm font-semibold text-foreground">
                {bothChannels
                  ? t("Same message for both channels")
                  : channel === "facebook"
                    ? t("Message sent in Messenger")
                    : t("Message sent as Instagram DM")}
              </p>
              <p className="mt-0.5 text-xs text-muted">
                {bothChannels
                  ? t(
                      "When someone comments the keyword, this text is sent as Facebook Messenger private reply and Instagram DM. No opening DM needed."
                    )
                  : channel === "facebook"
                    ? t(
                        "Sent as a private reply in Messenger when they comment the keyword."
                      )
                    : t(
                        "Sent as an Instagram DM when they comment the keyword."
                      )}
              </p>
            </div>
            <textarea
              value={dmMessage}
              onChange={(e) => setDmMessage(e.target.value)}
              placeholder={
                bothChannels
                  ? "متن قیمت / پکیج‌ها برای فیسبوک و اینستا…"
                  : t("Write a message")
              }
              rows={14}
              dir="auto"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm leading-6 text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none resize-y [unicode-bidi:plaintext]"
              maxLength={1000}
            />
            <p className="text-xs text-muted">
              {t("{count} / 1000 characters", { count: dmMessage.length })}
            </p>
          </div>

          {!bothChannels && channel === "instagram" ? (
            <div className="mt-3 space-y-3">
              <div className="rounded-lg border border-border p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm text-foreground">
                      {t("an opening DM")}
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      {t(
                        "Optional Instagram-only: send a button first; the message above is revealed after they tap."
                      )}
                    </p>
                  </div>
                  <Toggle
                    on={openingDmEnabled}
                    onToggle={() => setOpeningDmEnabled(!openingDmEnabled)}
                  />
                </div>
                {openingDmEnabled && (
                  <div className="mt-3 space-y-2">
                    <textarea
                      value={openingDmMessage}
                      onChange={(e) => setOpeningDmMessage(e.target.value)}
                      placeholder={t("Hey there! I'm so happy you're here 😊")}
                      rows={3}
                      dir="auto"
                      className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none resize-none [unicode-bidi:plaintext]"
                      maxLength={1000}
                    />
                    <input
                      value={openingDmButtonLabel}
                      onChange={(e) => setOpeningDmButtonLabel(e.target.value)}
                      placeholder={t("Send me the link")}
                      dir="auto"
                      className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none [unicode-bidi:plaintext]"
                      maxLength={64}
                    />
                  </div>
                )}
              </div>
              <div className="rounded-lg border border-border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-foreground">
                    {t("a follow requirement first")}
                  </span>
                  <Toggle
                    on={requireFollow}
                    onToggle={() => setRequireFollow(!requireFollow)}
                  />
                </div>
                {requireFollow && (
                  <div className="mt-3 space-y-2">
                    <textarea
                      value={followPromptMessage}
                      onChange={(e) => setFollowPromptMessage(e.target.value)}
                      placeholder={t(
                        "quick favor before i send your link. i don't make any money from this, it's free. if you want to support me, just don't unfollow after, and star the repo on github if it helps you. tap the button once you're following and i'll send it over"
                      )}
                      rows={3}
                      className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none resize-none"
                      maxLength={1000}
                    />
                    <input
                      value={followPromptButtonLabel}
                      onChange={(e) =>
                        setFollowPromptButtonLabel(e.target.value)
                      }
                      placeholder={t("i'm following")}
                      className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
                      maxLength={20}
                    />
                    <p className="text-xs text-muted">
                      {t(
                        "We send the link only after they tap the button and Instagram confirms the follow. If it can't be verified, we send it anyway."
                      )}
                    </p>
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </Section>

        <Section title={t("Optional link button")}>
          <div className="rounded-lg border border-border p-3 space-y-2">
            <span className="text-sm text-foreground">
              {t("Attach a tracked link button (optional)")}
            </span>
            {linkOpen ? (
              <div className="space-y-2">
                <input
                  value={trackedDestinationUrl}
                  onChange={(e) => setTrackedDestinationUrl(e.target.value)}
                  onBlur={ensureLinkToken}
                  placeholder="https://yourlink.com/offer"
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
                />
                <input
                  value={linkButtonLabel}
                  onChange={(e) => setLinkButtonLabel(e.target.value)}
                  placeholder={t("Button label (e.g. Open link)")}
                  maxLength={20}
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
                />
                {secondLinkOpen ? (
                  <div className="space-y-2 border-t border-border pt-2">
                    <input
                      value={secondaryDestinationUrl}
                      onChange={(e) => setSecondaryDestinationUrl(e.target.value)}
                      placeholder="https://yourlink.com/second"
                      className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
                    />
                    <input
                      value={secondaryButtonLabel}
                      onChange={(e) => setSecondaryButtonLabel(e.target.value)}
                      placeholder={t("Second button label")}
                      maxLength={20}
                      className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setSecondLinkOpen(true)}
                    className="w-full rounded-lg border border-border py-2 text-sm text-muted hover:text-foreground"
                  >
                    {t("+ Add A Second Link")}
                  </button>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setLinkOpen(true)}
                className="w-full rounded-lg border border-border py-2 text-sm text-muted hover:text-foreground"
              >
                {t("+ Add A Link")}
              </button>
            )}
            <p className="text-xs text-muted">
              {"{link}"} {t("inserts the tracked link;")} {"{username}"} {t("personalizes.")}
            </p>
          </div>
          <div className="mt-3 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-foreground">
                {t("a follow-up thank-you message")}
              </span>
              <Toggle
                on={followUpEnabled}
                onToggle={() => setFollowUpEnabled(!followUpEnabled)}
              />
            </div>
            {followUpEnabled && (
              <div className="mt-3 space-y-2">
                <textarea
                  value={followUpMessage}
                  onChange={(e) => setFollowUpMessage(e.target.value)}
                  placeholder={t("Btw just wanted to say thanks for following me, I appreciate the support 🙌")}
                  rows={3}
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none resize-none"
                  maxLength={1000}
                />
                <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
                  <span className="text-xs text-muted">{t("Send it")}</span>
                  <input
                    type="number"
                    min={0}
                    max={1440}
                    value={followUpDelayMinutes}
                    onChange={(e) =>
                      setFollowUpDelayMinutes(
                        Math.max(0, Math.min(1440, Math.floor(Number(e.target.value) || 0)))
                      )
                    }
                    className="w-20 rounded-lg border border-border bg-surface px-2 py-1 text-sm text-foreground focus:border-accent/40 focus:outline-none"
                  />
                  <span className="text-xs text-muted">
                    {t("minutes after the link")}
                  </span>
                </div>
                <p className="text-xs text-muted">
                  {followUpDelayMinutes > 0
                    ? t("Sent {minutes} min after they tap through.", { minutes: followUpDelayMinutes })
                    : t("Sent right after they tap through.")}
                  {" {username}"} {t("personalizes it. Max 24 hours, to stay inside Instagram's messaging window.")}
                </p>
              </div>
            )}
          </div>
        </Section>
      </div>

      {/* Right: preview */}
      <div>
        <p className="mb-4 text-sm text-muted">{t("Preview")}</p>
        <div className="flex min-w-0 justify-center lg:sticky lg:top-6 lg:block">
          <CampaignPreview
            tab={previewTab}
            onTabChange={setPreviewTab}
            username={username}
            avatarUrl={avatarUrl}
            postThumb={postThumb}
            caption={postCaption}
            sampleComment={keywords[0] ?? ""}
            dmTriggerEnabled={dmTriggerEnabled}
            publicReplyEnabled={publicReplyEnabled}
            publicReplyMessage={publicReplyMessages.find((m) => m.trim()) ?? ""}
            openingDmEnabled={openingDmEnabled}
            openingDmMessage={openingDmMessage}
            openingDmButtonLabel={openingDmButtonLabel}
            revealMessage={dmMessage}
            hasLink={Boolean(trackedDestinationUrl.trim())}
            linkButtonLabel={linkButtonLabel || "Open link"}
            linkUrl={trackedDestinationUrl.trim() || undefined}
            hasSecondLink={
              secondLinkOpen && Boolean(secondaryDestinationUrl.trim())
            }
            secondLinkButtonLabel={secondaryButtonLabel || "Open link"}
            requireFollow={requireFollow}
            followPromptMessage={followPromptMessage}
            followPromptButtonLabel={followPromptButtonLabel || "i'm following"}
            followUpEnabled={followUpEnabled}
            followUpMessage={followUpMessage}
            followUpDelayMinutes={followUpDelayMinutes}
          />
        </div>
      </div>
      </div>
    </div>
  );
}
