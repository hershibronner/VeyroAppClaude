// Production = deployed (Railway sets RAILWAY_ENVIRONMENT) or NODE_ENV=production. Local dev keeps the demo conveniences.
export const IS_PROD = !!process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production';
