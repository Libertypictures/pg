/**
 * Fold www onto the apex.
 *
 * The branded domain should have exactly one address. A zone-level Redirect
 * Rule would normally do this, but the Cloudflare credential available here
 * carries only `zone:read` — no zone-rule or DNS write — so the redirect lives
 * inside the Pages project instead, where it is versioned next to the site it
 * affects and cannot be changed from a dashboard by accident.
 *
 * This runs on every request, so it does the least possible work: anything that
 * is not the www host is passed straight through to the static assets, and the
 * body/path/query of the original request is preserved untouched.
 */
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const host = url.hostname.toLowerCase();

  if (host === 'www.libertymusa.com') {
    url.protocol = 'https:';
    url.hostname = 'libertymusa.com';
    return Response.redirect(url.toString(), 301);
  }

  return context.next();
}
