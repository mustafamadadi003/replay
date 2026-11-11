import { getMetaGraphApiVersion } from "@/lib/env";
import { noteMetaAppUsageFromResponse } from "@/lib/meta/app-rate-limit-circuit";
import type { LinkButton } from "@/lib/meta/client";

function facebookGraphBase() {
  return `https://graph.facebook.com/${getMetaGraphApiVersion()}`;
}

async function handleResponse<T>(response: Response): Promise<T> {
  await noteMetaAppUsageFromResponse(response).catch(() => {});
  const json = (await response.json()) as T & {
    error?: { message?: string; code?: number; type?: string };
  };
  if (!response.ok || json.error) {
    const message = json.error?.message ?? `Meta HTTP ${response.status}`;
    const error = new Error(message) as Error & { code?: number };
    error.code = json.error?.code;
    throw error;
  }
  return json;
}

function toWebUrlButtons(buttons: LinkButton[]) {
  return buttons.slice(0, 3).map((b) => ({
    type: "web_url" as const,
    title: b.title.slice(0, 20),
    url: b.url,
  }));
}

/** Private reply to a Page comment via Messenger (comment_id recipient). */
export async function sendFacebookPrivateReply(
  accessToken: string,
  pageId: string,
  commentId: string,
  message: string
): Promise<{ recipient_id?: string; message_id?: string }> {
  const response = await fetch(`${facebookGraphBase()}/${pageId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      recipient: { comment_id: commentId },
      message: { text: message },
    }),
  });
  return handleResponse(response);
}

export async function sendFacebookPrivateReplyWithLinkButton(
  accessToken: string,
  pageId: string,
  commentId: string,
  text: string,
  buttons: LinkButton[]
): Promise<{ recipient_id?: string; message_id?: string }> {
  const response = await fetch(`${facebookGraphBase()}/${pageId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      recipient: { comment_id: commentId },
      message: {
        attachment: {
          type: "template",
          payload: {
            template_type: "button",
            text: text.slice(0, 640),
            buttons: toWebUrlButtons(buttons),
          },
        },
      },
    }),
  });
  return handleResponse(response);
}

/** Public reply under a Page comment. */
export async function sendFacebookCommentReply(
  accessToken: string,
  commentId: string,
  message: string
): Promise<{ id?: string }> {
  const response = await fetch(`${facebookGraphBase()}/${commentId}/comments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ message }),
  });
  return handleResponse(response);
}

export type FacebookPagePost = {
  id: string;
  message?: string | null;
  created_time?: string;
  permalink_url?: string | null;
  full_picture?: string | null;
  comments?: {
    summary?: { total_count?: number; can_comment?: boolean };
  };
  commentsCount?: number;
};

export type FacebookPostComment = {
  id: string;
  message?: string | null;
  created_time?: string;
  from?: { id?: string; name?: string } | null;
};

/** List comments on a Page post (needs pages_read_user_content). */
export async function listFacebookPostComments(
  accessToken: string,
  postId: string,
  options?: { limit?: number; after?: string }
): Promise<{
  comments: FacebookPostComment[];
  nextCursor?: string;
}> {
  const url = new URL(`${facebookGraphBase()}/${postId}/comments`);
  // from{id,name} needs Business Asset User Profile Access for public users;
  // without it Meta omits `from` (webhooks still include the name).
  url.searchParams.set("fields", "id,from{id,name},message,created_time");
  url.searchParams.set("filter", "stream");
  url.searchParams.set("order", "chronological");
  url.searchParams.set("limit", String(options?.limit ?? 50));
  if (options?.after) url.searchParams.set("after", options.after);
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url.toString());
  const data = await handleResponse<{
    data?: FacebookPostComment[];
    paging?: { cursors?: { after?: string }; next?: string };
  }>(response);

  return {
    comments: data.data ?? [],
    nextCursor: data.paging?.cursors?.after,
  };
}

/** Resolve a Messenger user's display name after a private reply. */
export async function getFacebookMessengerParticipantName(
  accessToken: string,
  pageId: string,
  psid: string
): Promise<{ id: string; name: string } | null> {
  const url = new URL(`${facebookGraphBase()}/${pageId}/conversations`);
  url.searchParams.set("user_id", psid);
  url.searchParams.set("fields", "participants");
  url.searchParams.set("limit", "1");
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url.toString());
  const data = await handleResponse<{
    data?: Array<{
      participants?: { data?: Array<{ id?: string; name?: string }> };
    }>;
  }>(response);

  const participants = data.data?.[0]?.participants?.data ?? [];
  const person = participants.find((p) => p.id && p.id !== pageId && p.name);
  if (!person?.id || !person.name) return null;
  return { id: person.id, name: person.name };
}

/**
 * After a private reply, the thread's system message embeds `comment_id=…`.
 * Scan a few newest conversations to recover the commenter name when
 * `conversations?user_id=` is empty or Graph omits `from` on the comment.
 */
export async function resolveFacebookCommenterByCommentId(
  accessToken: string,
  pageId: string,
  commentId: string
): Promise<{ id: string; name: string } | null> {
  const shortId = commentId.includes("_")
    ? commentId.slice(commentId.lastIndexOf("_") + 1)
    : commentId;

  const url = new URL(`${facebookGraphBase()}/${pageId}/conversations`);
  url.searchParams.set(
    "fields",
    "participants,messages.limit(3){message}"
  );
  url.searchParams.set("limit", "25");
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url.toString());
  const data = await handleResponse<{
    data?: Array<{
      participants?: { data?: Array<{ id?: string; name?: string }> };
      messages?: { data?: Array<{ message?: string }> };
    }>;
  }>(response);

  for (const row of data.data ?? []) {
    const linked = (row.messages?.data ?? []).some((msg) => {
      const text = msg.message ?? "";
      return (
        text.includes(`comment_id=${shortId}`) ||
        text.includes(`comment_id=${commentId}`)
      );
    });
    if (!linked) continue;
    const person = (row.participants?.data ?? []).find(
      (p) => p.id && p.id !== pageId && p.name
    );
    if (person?.id && person.name) {
      return { id: person.id, name: person.name };
    }
  }
  return null;
}

/**
 * Walk recent Page conversations and map comment_id → commenter name.
 * Private-reply threads include a system message with `comment_id=` in the URL.
 */
export async function mapFacebookCommentersFromConversations(
  accessToken: string,
  pageId: string,
  options?: { maxPages?: number }
): Promise<Map<string, { id: string; name: string }>> {
  const out = new Map<string, { id: string; name: string }>();
  const maxPages = options?.maxPages ?? 30;
  let after: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(`${facebookGraphBase()}/${pageId}/conversations`);
    url.searchParams.set(
      "fields",
      "participants,messages.limit(4){message,from}"
    );
    url.searchParams.set("limit", "50");
    if (after) url.searchParams.set("after", after);
    url.searchParams.set("access_token", accessToken);

    const response = await fetch(url.toString());
    const data = await handleResponse<{
      data?: Array<{
        participants?: { data?: Array<{ id?: string; name?: string }> };
        messages?: { data?: Array<{ message?: string }> };
      }>;
      paging?: { cursors?: { after?: string }; next?: string };
    }>(response);

    const rows = data.data ?? [];
    if (!rows.length) break;

    for (const row of rows) {
      const person = (row.participants?.data ?? []).find(
        (p) => p.id && p.id !== pageId && p.name
      );
      if (!person?.id || !person.name) continue;

      for (const msg of row.messages?.data ?? []) {
        const text = msg.message ?? "";
        const match = text.match(/comment_id=(\d+)/i);
        if (!match?.[1]) continue;
        const shortId = match[1];
        out.set(shortId, { id: person.id, name: person.name });
      }
    }

    after = data.paging?.cursors?.after;
    if (!after || !data.paging?.next) break;
  }

  return out;
}

export async function getFacebookPostCommentCount(
  accessToken: string,
  postId: string
): Promise<number | null> {
  const url = new URL(`${facebookGraphBase()}/${postId}`);
  url.searchParams.set("fields", "comments.summary(true).limit(0)");
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url.toString());
  const data = await handleResponse<{
    comments?: { summary?: { total_count?: number } };
  }>(response);
  const total = data.comments?.summary?.total_count;
  return typeof total === "number" ? total : null;
}

export async function listFacebookPagePosts(
  accessToken: string,
  pageId: string,
  limit = 24
): Promise<FacebookPagePost[]> {
  const url = new URL(`${facebookGraphBase()}/${pageId}/posts`);
  url.searchParams.set(
    "fields",
    "id,message,created_time,permalink_url,full_picture,comments.summary(true).limit(0)"
  );
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url.toString());
  const data = await handleResponse<{ data?: FacebookPagePost[] }>(response);
  return (data.data ?? []).map((post) => ({
    ...post,
    commentsCount: post.comments?.summary?.total_count ?? 0,
  }));
}
