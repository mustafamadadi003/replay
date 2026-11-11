"use client";

/* eslint-disable @next/next/no-img-element */

/**
 * Post Picker
 *
 * Grid of Instagram / Facebook post thumbnails, selectable.
 */

import { useI18n } from "@/lib/i18n/provider";
import { useEffect, useState } from "react";
import { readCache, writeCache } from "@/lib/client-cache";

const PAGE_SIZE = 60;

interface InstagramPost {
  id: string;
  caption?: string;
  media_type: string;
  media_product_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  timestamp: string;
}

interface PostPickerProps {
  selectedPostId: string | null;
  channel?: "instagram" | "facebook";
  instagramAccountId?: string | null;
  facebookPageId?: string | null;
  /** postId -> name of the campaign already using it. Flagged in the grid. */
  usedPostIds?: Record<string, string>;
  /** Larger tiles for dual-channel / narrow layouts. */
  dense?: boolean;
  onSelect: (
    postId: string,
    postUrl?: string,
    thumbUrl?: string,
    caption?: string
  ) => void;
}

export default function PostPicker({
  selectedPostId,
  channel = "instagram",
  instagramAccountId,
  facebookPageId,
  usedPostIds,
  dense = false,
  onSelect,
}: PostPickerProps) {
  const { t } = useI18n();
  const [limitations, setLimitations] = useState<string[]>([]);
  const [posts, setPosts] = useState<InstagramPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE_SIZE);
  // Tracks thumbs that failed CDN load so we show the caption fallback.
  const [brokenThumbs, setBrokenThumbs] = useState<Record<string, true>>({});

  useEffect(() => {
    let cancelled = false;
    const isFacebook = channel === "facebook";
    setError(null);
    setLimitations([]);
    setShown(PAGE_SIZE);
    setBrokenThumbs({});
    if (isFacebook && !facebookPageId) {
      setPosts([]);
      setLoading(false);
      setError("Connect a Facebook Page first.");
      return;
    }
    if (!isFacebook && !instagramAccountId) {
      setPosts([]);
      setLoading(false);
      setError("Connect an Instagram account first.");
      return;
    }
    setLoading(true);
    const params = new URLSearchParams();
    if (isFacebook) {
      params.set("facebookPageId", facebookPageId!);
    } else {
      params.set("instagramAccountId", instagramAccountId!);
      params.set("all", "true");
    }

    // v2: carousel children thumbs + layout fix — bust stale caches.
    const cacheKey = isFacebook
      ? `fb-posts:v2:${facebookPageId ?? "default"}`
      : `ig-posts:v2:${instagramAccountId ?? "default"}`;
    const cached = readCache<InstagramPost[]>(cacheKey, 15 * 60 * 1000);
    /* eslint-disable react-hooks/set-state-in-effect */
    if (cached.data) {
      setPosts(cached.data);
      setLoading(false);
    }
    /* eslint-enable react-hooks/set-state-in-effect */

    const endpoint = isFacebook
      ? `/api/facebook/posts${params.size ? `?${params}` : ""}`
      : `/api/instagram/posts${params.size ? `?${params}` : ""}`;

    fetch(endpoint)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.success) {
          const normalized: InstagramPost[] = isFacebook
            ? (
                data.data as Array<{
                  id: string;
                  caption?: string;
                  mediaType?: string;
                  mediaUrl?: string;
                  permalink?: string;
                  timestamp?: string | null;
                }>
              ).map((p) => ({
                id: p.id,
                caption: p.caption,
                media_type: p.mediaType ?? "IMAGE",
                media_url: p.mediaUrl,
                thumbnail_url: p.mediaUrl,
                permalink: p.permalink,
                timestamp: p.timestamp ?? "",
              }))
            : data.data;
          setPosts(normalized);
          setLimitations(data.limitations ?? []);
          writeCache(cacheKey, normalized);
        } else if (!cached.data) {
          setError(data.error ?? "Failed to load posts");
        }
      })
      .catch(() => {
        if (!cancelled && !cached.data) setError("Failed to load posts");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [channel, facebookPageId, instagramAccountId]);

  if (loading) {
    return (
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
        {[...Array(8)].map((_, i) => (
          <div key={i} className="aspect-square rounded bg-surface" />
        ))}
      </div>
    );
  }

  if (error) {
    const hint =
      channel === "facebook"
        ? t("Select a Facebook Page above, then pick a post here.")
        : t("Select an Instagram account above, then pick a post or reel here.");
    return (
      <div className="text-center py-8">
        <p className="text-sm text-muted">
          {error === "Failed to load posts" ? t("Failed to load posts") : error}
        </p>
        <p className="text-xs text-zinc-500 mt-1">{hint}</p>
      </div>
    );
  }

  if (posts.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-sm text-muted">{t("No posts found")}</p>
      </div>
    );
  }

  const matching = query.trim()
    ? posts.filter((p) =>
        (p.caption ?? "").toLowerCase().includes(query.trim().toLowerCase())
      )
    : posts;

  const visible = matching.slice(0, shown);
  const remaining = matching.length - visible.length;

  return (
    <div className="space-y-2">
      {limitations.map((note) => (
        <p key={note} className="text-xs text-muted">
          {note}
        </p>
      ))}
      <div className="flex items-center justify-between gap-2">
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setShown(PAGE_SIZE);
          }}
          placeholder={t("Search your posts by caption…")}
          className="w-full min-w-0 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
        />
        <span className="shrink-0 text-xs text-muted">{posts.length}</span>
      </div>
      {visible.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">
          {t("No posts match “")}
          {query}
          {t("”")}
        </p>
      ) : (
        <>
          {usedPostIds && Object.keys(usedPostIds).length > 0 && (
            <p className="flex items-center gap-1.5 px-1 text-[11px] text-muted">
              <span className="inline-block h-2.5 w-2.5 rounded-sm border border-warning/50" />
              {t("Already used")}
            </p>
          )}
          <div
            className={`grid gap-2 overflow-x-hidden overflow-y-auto p-1 ${
              dense
                ? "grid-cols-2 sm:grid-cols-3 max-h-[28rem]"
                : "grid-cols-3 sm:grid-cols-4 max-h-80"
            }`}
            style={{ gridAutoRows: "min-content" }}
          >
            {visible.map((post) => {
              const isSelected = selectedPostId === post.id;
              const usedByName = usedPostIds?.[post.id];
              const isUsed = Boolean(usedByName) && !isSelected;
              const thumb = post.thumbnail_url || post.media_url;
              const thumbBroken = Boolean(brokenThumbs[post.id]);
              const showThumb = Boolean(thumb) && !thumbBroken;
              const isVideo =
                post.media_type === "VIDEO" ||
                post.media_type === "REELS" ||
                post.media_product_type === "REELS";
              const showVideo =
                isVideo && hoveredId === post.id && Boolean(post.media_url);
              const captionPreview =
                (post.caption ?? "").trim().slice(0, 80) ||
                (channel === "facebook" ? "Facebook post" : "Instagram post");
              return (
                <button
                  key={post.id}
                  type="button"
                  onClick={() =>
                    onSelect(post.id, post.permalink, thumb, post.caption)
                  }
                  onMouseEnter={() => setHoveredId(post.id)}
                  onMouseLeave={() =>
                    setHoveredId((cur) => (cur === post.id ? null : cur))
                  }
                  aria-pressed={isSelected}
                  title={
                    isUsed && usedByName
                      ? t('Already used by "{name}"', { name: usedByName })
                      : captionPreview
                  }
                  className={`
              relative aspect-square w-full min-w-0 overflow-hidden rounded-lg border-2 bg-surface
              ${
                isSelected
                  ? "border-accent"
                  : isUsed
                    ? "border-warning/40 hover:border-warning/60"
                    : "border-border hover:border-border-hover"
              }
            `}
                >
                  {showThumb ? (
                    <img
                      src={thumb}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      referrerPolicy="no-referrer"
                      onError={() =>
                        setBrokenThumbs((prev) => ({
                          ...prev,
                          [post.id]: true,
                        }))
                      }
                      className={`absolute inset-0 h-full w-full object-cover ${isUsed ? "opacity-75" : ""}`}
                    />
                  ) : (
                    <div className="absolute inset-0 flex items-end bg-gradient-to-b from-zinc-800 to-zinc-950 p-2">
                      <span
                        className="line-clamp-4 w-full break-words text-left text-[11px] leading-snug text-zinc-100"
                        dir="auto"
                      >
                        {captionPreview}
                      </span>
                    </div>
                  )}
                  {showVideo && (
                    <video
                      src={post.media_url}
                      poster={thumb}
                      autoPlay
                      muted
                      loop
                      playsInline
                      preload="none"
                      className={`absolute inset-0 h-full w-full object-cover ${
                        isUsed ? "opacity-60" : ""
                      }`}
                    />
                  )}
                  {isSelected && (
                    <span className="absolute bottom-0 inset-x-0 bg-accent text-white text-xs py-1">
                      {t("Selected")}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {remaining > 0 && (
            <button
              type="button"
              onClick={() => setShown((n) => n + PAGE_SIZE)}
              className="w-full rounded-lg border border-border py-2 text-sm text-muted hover:text-foreground"
            >
              {t("Show")} {Math.min(PAGE_SIZE, remaining)} {t("more")}
            </button>
          )}
        </>
      )}
    </div>
  );
}
