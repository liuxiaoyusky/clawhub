export function navigateToAuthorizationUrl(authorizationUrl: string) {
  window.location.assign(authorizationUrl);
}

export function normalizeIdentityRedirect(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}
