// Optional password gate for the confidential brief (Vercel Routing Middleware).
//
// DISABLED unless SITE_PASSWORD is set in the Vercel environment — deploying this
// file alone changes nothing. When SITE_PASSWORD is set, every page/asset requires
// that password (HTTP Basic Auth) before it loads. The lead API (/api/*) is left
// open so the form keeps working after the visitor has unlocked the page.
//
// Activate:   Vercel → Settings → Environment Variables → add SITE_PASSWORD → Redeploy.
// Deactivate: delete SITE_PASSWORD → Redeploy.

export const config = {
  // Gate everything except the form API. Static assets load once authenticated.
  matcher: ['/((?!api/).*)'],
};

export default function middleware(request) {
  const password = process.env.SITE_PASSWORD;
  if (!password) return; // gate off when unconfigured -> serve normally

  const header = request.headers.get('authorization') || '';
  if (header.startsWith('Basic ')) {
    let decoded = '';
    try { decoded = atob(header.slice(6)); } catch (_) { decoded = ''; }
    const pwd = decoded.slice(decoded.indexOf(':') + 1); // ignore username, check password
    if (pwd === password) return; // correct -> serve normally
  }

  return new Response('Authentication required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="VitaBahn — confidential brief", charset="UTF-8"',
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}
