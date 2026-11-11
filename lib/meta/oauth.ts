import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "crypto";
import {
  getEncryptionKeyHex,
  getFacebookAppId,
  getFacebookAppSecret,
  getMetaGraphApiVersion,
  requireEnv,
} from "@/lib/env";

// Instagram API with Instagram Login authorizes on www.instagram.com. The old
// api.instagram.com/oauth/authorize host belonged to the retired Basic Display
// API and now 404s ("Sorry, this page isn't available"), which looks like a bad
// link rather than a wrong endpoint. The token exchange below still lives on
// api.instagram.com — only the authorize hop moved.
//
// Newer Meta apps cannot use Instagram Login at all; they must use Unified
// Login (Facebook Login for Business + config_id). When FACEBOOK_CONFIG_ID is
// set we take that path instead.
const INSTAGRAM_OAUTH_URL = "https://www.instagram.com/oauth/authorize";
const INSTAGRAM_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const UNIFIED_OAUTH_URL = "https://www.facebook.com/dialog/oauth";
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

export function isUnifiedLoginEnabled(): boolean {
  return Boolean(process.env.FACEBOOK_CONFIG_ID?.trim());
}

interface OAuthStatePayload {
  workspaceId: string;
  ts: number;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signState(payload: string): string {
  return createHmac("sha256", requireEnv("NEXTAUTH_SECRET"))
    .update(payload)
    .digest("base64url");
}

export function createOAuthState(workspaceId: string): string {
  const payload = base64UrlEncode(
    JSON.stringify({ workspaceId, ts: Date.now() } satisfies OAuthStatePayload)
  );
  return `${payload}.${signState(payload)}`;
}

export function verifyOAuthState(state: string | null): OAuthStatePayload | null {
  if (!state) return null;

  const [payload, signature] = state.split(".");
  if (!payload || !signature) return null;

  const expected = signState(payload);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(base64UrlDecode(payload)) as OAuthStatePayload;
    if (typeof parsed.workspaceId !== "string" || !parsed.workspaceId) {
      return null;
    }

    // Reject a missing or non-numeric timestamp. `Date.now() - "abc"` is NaN,
    // and every comparison against NaN is false, so a non-numeric ts would
    // otherwise pass the age check and never expire. A ts in the future is
    // rejected for the same reason: it has not aged at all.
    if (typeof parsed.ts !== "number" || !Number.isFinite(parsed.ts)) {
      return null;
    }

    const age = Date.now() - parsed.ts;
    if (age < 0 || age > STATE_MAX_AGE_MS) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function getAuthorizationUrl(redirectUri: string, state: string): string {
  if (isUnifiedLoginEnabled()) {
    const params = new URLSearchParams({
      client_id: requireEnv("INSTAGRAM_APP_ID"),
      config_id: requireEnv("FACEBOOK_CONFIG_ID"),
      redirect_uri: redirectUri,
      response_type: "code",
      // Force the login chooser so Instagram appears even when Facebook is
      // already signed in in the browser.
      prompt: "login",
      state,
      override_default_response_type: "true",
    });
    return `${UNIFIED_OAUTH_URL}?${params.toString()}`;
  }

  const params = new URLSearchParams({
    client_id: requireEnv("INSTAGRAM_APP_ID"),
    redirect_uri: redirectUri,
    scope:
      "instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments,instagram_business_manage_insights",
    response_type: "code",
    state,
  });

  return `${INSTAGRAM_OAUTH_URL}?${params.toString()}`;
}

/** Classic Facebook Login — grants Page tokens via /me/accounts. */
const FACEBOOK_PAGE_SCOPES = [
  "pages_show_list",
  "pages_messaging",
  "pages_manage_metadata",
  "pages_read_engagement",
  "pages_read_user_content",
  "pages_manage_engagement",
].join(",");

export function getFacebookPageAuthorizationUrl(
  redirectUri: string,
  state: string
): string {
  const appId = getFacebookAppId();
  if (!appId) {
    throw new Error("FACEBOOK_APP_ID (or INSTAGRAM_APP_ID) is required");
  }
  const version = getMetaGraphApiVersion();
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    state,
    response_type: "code",
    scope: FACEBOOK_PAGE_SCOPES,
    // Re-prompt so admins can add more Pages later.
    auth_type: "rerequest",
  });
  return `https://www.facebook.com/${version}/dialog/oauth?${params.toString()}`;
}

export async function exchangeFacebookCodeForToken(
  code: string,
  redirectUri: string
): Promise<{ accessToken: string }> {
  const appId = getFacebookAppId();
  const appSecret = getFacebookAppSecret();
  if (!appId || !appSecret) {
    throw new Error("FACEBOOK_APP_ID / FACEBOOK_APP_SECRET are required");
  }

  const version = getMetaGraphApiVersion();
  const url = new URL(
    `https://graph.facebook.com/${version}/oauth/access_token`
  );
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code", code);

  const response = await fetch(url.toString());
  const data = (await response.json()) as {
    access_token?: string;
    error?: { message?: string };
  };

  if (!response.ok || !data.access_token) {
    throw new Error(
      `Facebook token exchange failed: ${
        data.error?.message || JSON.stringify(data)
      }`
    );
  }

  return { accessToken: data.access_token };
}

/** Exchange a short-lived user token for a ~60-day long-lived user token. */
export async function exchangeFacebookLongLivedUserToken(
  shortLivedToken: string
): Promise<{ accessToken: string; expiresIn: number }> {
  const appId = getFacebookAppId();
  const appSecret = getFacebookAppSecret();
  if (!appId || !appSecret) {
    throw new Error("FACEBOOK_APP_ID / FACEBOOK_APP_SECRET are required");
  }

  const version = getMetaGraphApiVersion();
  const url = new URL(
    `https://graph.facebook.com/${version}/oauth/access_token`
  );
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("fb_exchange_token", shortLivedToken);

  const response = await fetch(url.toString());
  const data = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: { message?: string };
  };

  if (!response.ok || !data.access_token) {
    throw new Error(
      `Facebook long-lived exchange failed: ${
        data.error?.message || JSON.stringify(data)
      }`
    );
  }

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in ?? 60 * 24 * 60 * 60,
  };
}

export async function exchangeCodeForToken(
  code: string,
  redirectUri: string
): Promise<{ accessToken: string; userId?: string }> {
  if (isUnifiedLoginEnabled()) {
    // Unified Login exchanges on graph.facebook.com. redirect_uri must match
    // the authorize hop exactly (Meta rejects the code otherwise).
    const version = process.env.META_GRAPH_API_VERSION ?? "v25.0";
    const url = new URL(`https://graph.facebook.com/${version}/oauth/access_token`);
    url.searchParams.set("client_id", requireEnv("INSTAGRAM_APP_ID"));
    url.searchParams.set("client_secret", requireEnv("INSTAGRAM_APP_SECRET"));
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("code", code);

    const response = await fetch(url.toString());
    const data = (await response.json()) as {
      access_token?: string;
      error?: { message?: string };
      error_message?: string;
    };

    if (!response.ok || !data.access_token) {
      throw new Error(
        `Token exchange failed: ${
          data.error?.message || data.error_message || JSON.stringify(data)
        }`
      );
    }

    return { accessToken: data.access_token };
  }

  const body = new URLSearchParams({
    client_id: requireEnv("INSTAGRAM_APP_ID"),
    client_secret: requireEnv("INSTAGRAM_APP_SECRET"),
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code,
  });

  const response = await fetch(INSTAGRAM_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Token exchange failed: ${error.error_message || JSON.stringify(error)}`
    );
  }

  const data = await response.json();
  return {
    accessToken: data.access_token,
    userId: String(data.user_id),
  };
}

function getEncryptionKey(): Buffer {
  return Buffer.from(getEncryptionKeyHex(), "hex");
}

export function encryptToken(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, authTag, encrypted]);

  return combined.toString("base64");
}

export function decryptToken(encryptedBase64: string): string {
  const key = getEncryptionKey();
  const combined = Buffer.from(encryptedBase64, "base64");

  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    "utf8"
  );
}
