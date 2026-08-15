export const GITHUB_IDENTITY_LINK_STORAGE_KEY = "clawhub:m2:github-link";

export function readGitHubIdentityLinkSecret() {
  if (typeof window === "undefined") return null;
  const secret = window.sessionStorage.getItem(GITHUB_IDENTITY_LINK_STORAGE_KEY)?.trim();
  return secret || null;
}

export function writeGitHubIdentityLinkSecret(secret: string) {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(GITHUB_IDENTITY_LINK_STORAGE_KEY, secret);
}

export function clearGitHubIdentityLinkSecret() {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(GITHUB_IDENTITY_LINK_STORAGE_KEY);
}

export function normalizeIdentityRedirect(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}
