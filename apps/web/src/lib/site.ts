// Two faces of one deploy: the marketing site (voicechart.app) shows only the landing page at "/",
// and every app link (sign in, sign up, deep links) goes to the portal (portal.voicechart.app).
// marketing.localhost lets you preview the marketing face locally.
export const PORTAL_ORIGIN = 'https://portal.voicechart.app';
const MARKETING_HOSTS = ['voicechart.app', 'www.voicechart.app', 'marketing.localhost'];

export const isMarketingSite = typeof window !== 'undefined' && MARKETING_HOSTS.includes(window.location.hostname);

const portalOrigin = () => (window.location.hostname === 'marketing.localhost' ? `${window.location.protocol}//localhost:${window.location.port}` : PORTAL_ORIGIN);

/** Where an app path lives: same site normally, the portal when on the marketing site. */
export const appHref = (path: string) => (isMarketingSite ? portalOrigin() + path : path);
