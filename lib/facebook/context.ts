import { decryptToken } from "@/lib/meta/oauth";

export type FacebookPageCredentials = {
  pageId: string;
  accessToken: string;
};

export type FacebookContext = {
  accessToken: string;
  pageId: string;
};

export function hasFacebookCredentials(
  page: Pick<FacebookPageCredentials, "accessToken" | "pageId">
) {
  return Boolean(page.accessToken && page.pageId);
}

export function createFacebookContext(
  page: FacebookPageCredentials
): FacebookContext {
  return {
    accessToken: decryptToken(page.accessToken),
    pageId: page.pageId,
  };
}
