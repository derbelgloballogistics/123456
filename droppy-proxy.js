// Netlify Edge Function: serves app.droppy.tn through this site, so the Derbel Tracker (index.html)
// and Droppy are the SAME website. The tracker can then apply its Droppy layouts directly — no Tampermonkey.
//
//   /                      -> the tracker (index.html), unchanged
//   /?droppy=1#/...        -> Droppy (this is what the tracker's Droppy frame loads)
//   /main.js, /assets/...  -> Droppy's own files (anything that is not a file of this site)
//   /__p/<host>/...        -> Droppy's other servers (api.droppy.tn etc.)

const DROPPY = 'https://app.droppy.tn';
// Droppy servers that may be reached through /__p/. Add a host here if Droppy uses one outside *.droppy.tn.
const EXTRA_HOSTS = [];
const allowedHost = h => /(^|\.)droppy\.tn$/i.test(h) || EXTRA_HOSTS.includes(h.toLowerCase());

const TEXT = /(text\/html|javascript|ecmascript|application\/json|text\/css|manifest)/i;

// Rewrites links to Droppy servers so they go through this site
function rewriteText(body, origin) {
  const esc = origin.replace(/\//g, '\\/');
  return body
    // https://app.droppy.tn  ->  this site
    .replace(/https?:\/\/app\.droppy\.tn(?![a-z0-9.-])/gi, origin)
    .replace(/https?:\\\/\\\/app\.droppy\.tn(?![a-z0-9.-])/gi, esc)
    // https://<other>.droppy.tn  ->  this site/__p/<other>.droppy.tn   (wss:// websockets are left alone)
    .replace(/(?:https?:\/\/|(?<![a-z:])\/\/)([a-z0-9-]+(?:\.[a-z0-9-]+)*\.droppy\.tn)(?![a-z0-9.-])/gi,
      (m, host) => origin + '/__p/' + host.toLowerCase())
    .replace(/https?:\\\/\\\/([a-z0-9-]+(?:\.[a-z0-9-]+)*\.droppy\.tn)(?![a-z0-9.-])/gi,
      (m, host) => esc + '\\/__p\\/' + host.toLowerCase());
}

function rewriteLocation(loc, origin) {
  if (!loc) return loc;
  try {
    const u = new URL(loc, DROPPY);
    if (u.host === 'app.droppy.tn') return origin + u.pathname + u.search + u.hash;
    if (allowedHost(u.host)) return origin + '/__p/' + u.host + u.pathname + u.search + u.hash;
  } catch (e) { /* keep as is */ }
  return loc;
}

export default async (request, context) => {
  const url = new URL(request.url);
  const origin = url.origin;
  const isRoot = url.pathname === '/' || url.pathname === '/index.html';
  const inFrame = request.headers.get('sec-fetch-dest') === 'iframe';

  // 1) The tracker itself (top-level visit of the site). Tell it Droppy is available through this site.
  if (isRoot && !url.searchParams.has('droppy') && !inFrame) {
    const res = await context.next();
    if (!(res.headers.get('content-type') || '').includes('text/html')) return res;
    const html = (await res.text()).replace(/<head([^>]*)>/i, '<head$1><script>window.DERBEL_DROPPY_PROXY=true;</script>');
    const h = new Headers(res.headers); h.delete('content-length');
    return new Response(html, { status: res.status, headers: h });
  }

  // 2) Other files of this site win (if you add any); everything else is Droppy
  if (!isRoot && !url.pathname.startsWith('/__p/')) {
    const own = await context.next();
    if (own.status !== 404) return own;
  }

  // 3) Build the Droppy address
  let target;
  if (url.pathname.startsWith('/__p/')) {
    const rest = url.pathname.slice(5);
    const i = rest.indexOf('/');
    const host = i < 0 ? rest : rest.slice(0, i);
    if (!allowedHost(host)) return new Response('Host not allowed', { status: 403 });
    target = 'https://' + host + (i < 0 ? '/' : rest.slice(i)) + url.search;
  } else {
    const sp = new URLSearchParams(url.search);
    sp.delete('droppy');
    const q = sp.toString();
    target = DROPPY + url.pathname + (q ? '?' + q : '');
  }

  // 4) Forward the request as if it came from app.droppy.tn
  const fwd = new Headers(request.headers);
  ['host', 'x-forwarded-host', 'x-forwarded-for', 'x-nf-client-connection-ip', 'accept-encoding'].forEach(k => fwd.delete(k));
  if (fwd.has('origin')) fwd.set('origin', DROPPY);
  if (fwd.has('referer')) fwd.set('referer', DROPPY + '/');
  const init = { method: request.method, headers: fwd, redirect: 'manual' };
  if (!['GET', 'HEAD'].includes(request.method)) init.body = await request.arrayBuffer();
  let up;
  try { up = await fetch(target, init); }
  catch (e) { return new Response('Droppy is not reachable: ' + e.message, { status: 502 }); }

  // 5) Clean the answer: allow framing, keep cookies on this site, point links back here
  const h = new Headers(up.headers);
  ['x-frame-options', 'content-security-policy', 'content-security-policy-report-only',
   'content-length', 'content-encoding', 'strict-transport-security'].forEach(k => h.delete(k));
  h.delete('access-control-allow-origin'); h.delete('access-control-allow-credentials');
  const cookies = typeof up.headers.getSetCookie === 'function' ? up.headers.getSetCookie() : [];
  if (cookies.length) {
    h.delete('set-cookie');
    cookies.forEach(c => h.append('set-cookie', c.replace(/;\s*domain=[^;]*/gi, '').replace(/;\s*samesite=none/gi, '; SameSite=Lax')));
  }
  if (h.has('location')) h.set('location', rewriteLocation(h.get('location'), origin));

  const type = h.get('content-type') || '';
  if (TEXT.test(type) && request.method !== 'HEAD' && up.status !== 204 && up.status !== 304) {
    const text = rewriteText(await up.text(), origin);
    return new Response(text, { status: up.status, headers: h });
  }
  return new Response(up.body, { status: up.status, headers: h });
};

export const config = { path: '/*' };
