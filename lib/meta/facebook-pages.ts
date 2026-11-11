import { getMetaGraphApiVersion } from "@/lib/env";
import { noteMetaAppUsageFromResponse } from "@/lib/meta/app-rate-limit-circuit";

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

export type DiscoverableFacebookPage = {
  id: string;
  name: string;
  /** Page-scoped token when Meta returns one from /me/accounts. */
  accessToken: string;
};

/**
 * Lists Facebook Pages available to this user/system-user token.
 * Prefers each page's own access_token when Meta includes it.
 */
export async function listFacebookPagesForToken(
  accessToken: string
): Promise<DiscoverableFacebookPage[]> {
  const url = new URL(`${facebookGraphBase()}/me/accounts`);
  url.searchParams.set("fields", "id,name,access_token,tasks");
  url.searchParams.set("limit", "100");
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url.toString());
  const data = await handleResponse<{
    data?: Array<{
      id?: string;
      name?: string;
      access_token?: string;
    }>;
  }>(response);

  return (data.data ?? [])
    .filter((page): page is { id: string; name: string; access_token?: string } =>
      Boolean(page.id && page.name)
    )
    .map((page) => ({
      id: page.id,
      name: page.name,
      accessToken: page.access_token?.trim() || accessToken,
    }));
}

export async function fetchFacebookPageById(
  accessToken: string,
  pageId: string
): Promise<DiscoverableFacebookPage | null> {
  const url = new URL(`${facebookGraphBase()}/${pageId}`);
  url.searchParams.set("fields", "id,name,access_token");
  url.searchParams.set("access_token", accessToken);
  try {
    const response = await fetch(url.toString());
    const page = await handleResponse<{
      id?: string;
      name?: string;
      access_token?: string;
    }>(response);
    if (!page.id || !page.name) return null;
    return {
      id: page.id,
      name: page.name,
      accessToken: page.access_token?.trim() || accessToken,
    };
  } catch {
    return null;
  }
}

/** Subscribe the Page to feed + messages webhooks for this app. */
export async function subscribeFacebookPageToWebhooks(
  pageId: string,
  pageAccessToken: string
): Promise<{ success: boolean }> {
  const response = await fetch(
    `${facebookGraphBase()}/${pageId}/subscribed_apps`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        subscribed_fields: "feed,messages",
        access_token: pageAccessToken,
      }),
    }
  );
  return handleResponse(response);
}
