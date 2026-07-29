/**
 * Pixiv bulk private/public follows
 *
 * Sets all your follows from public to private or vice-versa based on the type viewed.
 * Uses Pixiv's stable Ajax endpoints instead of DOM scraping, ensuring longevity.
 *
 * Wrapped in an IIFE for browser compatibility.
 */
(async function iife() {
  'use strict';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tag = '%c[pixiv-bulk-follow]';
  const log  = (...a) => console.log(tag, 'color:#0096fa;font-weight:bold', ...a);
  const warn = (...a) => console.warn(tag, 'color:#ff9800;font-weight:bold', ...a);
  const err  = (...a) => console.error(tag, 'color:#ff4060;font-weight:bold', ...a);

  // ---------- 1. Determine user + flip direction ----------
  const path = location.pathname.replace(/^\/en/, '');
  const m = path.match(/^\/users\/(\d+)\/following/);
  if (!m) throw new Error('Run this on your Following page (/users/<id>/following).');
  const myUserId = m[1];
  const viewingPrivate = new URLSearchParams(location.search).get('rest') === 'hide';
  const sourceRest     = viewingPrivate ? 'hide' : 'show';
  const targetRestrict = viewingPrivate ? 0 : 1;        // 0 = public, 1 = private
  const targetLabel    = targetRestrict === 1 ? 'private' : 'public';

  if (!confirm(
    `Bulk follow conversion\n\n` +
    `Viewing your ${viewingPrivate ? 'PRIVATE' : 'PUBLIC'} follows.\n` +
    `All will be set to ${targetLabel.toUpperCase()}.\n\nProceed?`
  )) { log('Aborted.'); return; }

  log(`Converting ${viewingPrivate ? 'private→public' : 'public→private'} (target restrict = ${targetRestrict}).`);

  // ---------- 2. CSRF token ----------
  function getCsrfToken() {
    // Primary: Parse from Next.js state
    try {
      const nd = document.getElementById('__NEXT_DATA__');
      if (nd && nd.textContent) {
        const data = JSON.parse(nd.textContent);
        const serialized = data?.props?.pageProps?.serverSerializedPreloadedState;
        if (typeof serialized === 'string') {
          const state = JSON.parse(serialized);
          if (state?.api?.token) return state.api.token;
        }
      }
    } catch (_) {}
    
    // Fallback 1: Legacy global
    try {
      if (window.pixiv?.context?.token) return window.pixiv.context.token;
    } catch (_) {}

    // Fallback 2: Regex search the raw HTML for the token
    try {
      const html = document.documentElement.innerHTML;
      const match = html.match(/"token":"([a-z0-9]+)"/i);
      if (match && match[1]) return match[1];
    } catch (_) {}

    throw new Error('CSRF token not found — make sure you are logged in to pixiv.');
  }
  const csrf = getCsrfToken();
  log('CSRF token acquired.');

  // ---------- 3. Read follow list ----------
  const LIMIT = 24;
  async function fetchFollowing(rest, offset) {
    const url = `https://www.pixiv.net/ajax/user/${myUserId}/following?offset=${offset}&limit=${LIMIT}&rest=${rest}`;
    const res = await fetch(url, { credentials:'same-origin', headers:{ Accept:'application/json' } });
    if (res.status === 401 || res.status === 403) throw new Error('Not authorized — log in to pixiv.');
    if (!res.ok) throw new Error(`Following list HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(json.message || 'Ajax following API error.');
    return json.body;
  }

  const first = await fetchFollowing(sourceRest, 0);
  const total = (typeof first.total === 'number') ? first.total : (first.users?.length || 0);
  if (!total) { log('No follows to convert.'); return; }
  log(`Found ${total} ${viewingPrivate ? 'private' : 'public'} follow(s).`);

  const userIds = [];
  let offset = 0, body = first;
  while (true) {
    const users = Array.from(body.users || []);
    if (!users.length) break;
    for (const u of users) if (u?.userId) userIds.push(u.userId);
    offset += users.length;
    if ((typeof body.total === 'number' && offset >= body.total) || users.length < LIMIT) break;
    await sleep(300);
    body = await fetchFollowing(sourceRest, offset);
  }
  log(`Collected ${userIds.length} user(s). Starting conversion…`);

  // ---------- 4. Change restrict via /ajax/following/user/restrict_change ----------
  let done = 0, failed = 0;
  const failedIds = [];

  for (const id of userIds) {
    const params = new URLSearchParams({
      user_id: String(id),
      restrict: String(targetRestrict),
    });
    try {
      const res = await fetch('https://www.pixiv.net/ajax/following/user/restrict_change', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrf,
        },
        body: params,
        credentials: 'same-origin',
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { const j = await res.json(); detail = j.message || detail; } catch (_) {}
        throw new Error(detail);
      }
      done++;
      log(`${done}/${userIds.length}: ${id} → ${targetLabel}`);
    } catch (e) {
      failed++;
      failedIds.push(id);
      warn(`${id} FAILED: ${e.message}`);
    }
    await sleep(700); // ~1/sec to avoid rate limiting
  }

  log(`Done. ${done} converted, ${failed} failed.`);
  if (failedIds.length) {
    err('Failed IDs:', failedIds.join(', '));
  } else {
    log('Reloading in 1s…');
    await sleep(1000);
    location.reload();
  }
})();
