// Analytics, tag, pixel and chat hosts that a screenshot or a style sample never needs. Blocking
// them keeps test loads out of the live site's reports and late widgets out of the shot.
// The same file lives in visual-review and convert-site; a test keeps the copies identical and a
// superset of the tracking vendors parity-gates names.

// A request is blocked when its host is one of these or a subdomain of one.
export const BLOCKED_HOSTS = [
  // Google Analytics, Tag Manager and the ad conversion pixels they load
  'google-analytics.com', 'analytics.google.com', 'googletagmanager.com', 'googleadservices.com', 'doubleclick.net',
  // Facebook (Meta) pixel
  'connect.facebook.net',
  // Hotjar, Microsoft Clarity
  'hotjar.com', 'hotjar.io', 'clarity.ms',
  // HubSpot tracking, cookie banner and chat (not js.hsforms.net, which draws a form)
  'hs-scripts.com', 'hs-analytics.net', 'hs-banner.com', 'hscollectedforms.net', 'usemessages.com',
  // Intercom, Drift
  'intercom.io', 'intercomcdn.com', 'drift.com', 'driftt.com',
  // LinkedIn insight, TikTok and Pinterest tags
  'snap.licdn.com', 'px.ads.linkedin.com', 'analytics.tiktok.com', 'ct.pinterest.com',
  // Segment, Mixpanel, Plausible, Fathom, Matomo cloud
  'segment.com', 'segment.io', 'mxpnl.com', 'mixpanel.com', 'plausible.io', 'usefathom.com', 'matomo.cloud', 'innocraft.cloud',
  // Crisp, Tawk and Zendesk chat
  'crisp.chat', 'tawk.to', 'zdassets.com', 'zopim.com',
];

const onHost = (url, hosts) => {
  const host = url.hostname.toLowerCase();
  return hosts.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
};

// extra: more hosts to block for this run (--block-hosts).
export function isBlockedUrl(url, extra = []) {
  return onHost(url, BLOCKED_HOSTS) || onHost(url, extra);
}

// The host names of a --block-hosts value ("cmp.osano.com,consent.example.com"), lower case.
// Throws on anything that is not a bare host name.
export function parseBlockHosts(value) {
  const hosts = String(value).split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const bad = hosts.filter((h) => !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(h));
  if (bad.length || hosts.length === 0) throw new Error(`--block-hosts takes host names separated by commas, such as cmp.osano.com; got "${value}"`);
  return hosts;
}

// Aborts every request a Playwright browser context makes to a blocked host: the analytics list
// unless analytics is false (--allow-analytics), and the extra hosts always.
export async function blockAnalytics(context, { extra = [], analytics = true } = {}) {
  if (!analytics && extra.length === 0) return;
  const blocked = (url) => (analytics ? isBlockedUrl(url, extra) : onHost(url, extra));
  await context.route(blocked, (route) => route.abort('blockedbyclient'));
}
