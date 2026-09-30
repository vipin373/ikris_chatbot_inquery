/**
 * IKRIS PHARMA NETWORK — Department Inquiry Dashboard
 * config.js — the ONE place to configure the frontend.
 *
 * Everything in this file is safe to publish on GitHub Pages:
 *  • SUPABASE_URL              public project URL
 *  • SUPABASE_PUBLISHABLE_KEY  public client key (sb_publishable_...). Designed for browsers.
 *  • GOOGLE_APPS_SCRIPT_URL    public Web App URL; it returns data only for a valid Supabase session.
 *
 * NEVER put these here (or anywhere in the repository):
 *  ✗ Supabase service_role / secret key (sb_secret_...)
 *  ✗ Google service-account private keys, OAuth client secrets, passwords
 */
window.IKRIS_CONFIG = Object.freeze({
  // Supabase project "IKRIS Dashboard"
  SUPABASE_URL: 'https://mdyniigwwhupdnxwtnvo.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_VpQjX0Y7Fh6PGrx0TmlAQA_dQ6t8xPf',

  // Paste your Apps Script Web App URL here after deploying (ends with /exec).
  GOOGLE_APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycby2Jfb9REtb89dYxSqDO_DgQ1Bm0GDaklhdC8xi0rFnnW_VJXh_DPwr6fJt5Os0IB0eMg/exec',

  // Public URL of this dashboard, used for email confirmation + password reset links.
  // Leave empty to use the current page address automatically.
  // Example: 'https://ikris-chatbot-inquery.vercel.app/'
  APP_URL: '',

  // Live refresh interval (milliseconds). 30 seconds by default.
  REFRESH_INTERVAL_MS: 30000,

  // Rows per page in the inquiry table.
  PAGE_SIZE: 25,

  // Minimum password length enforced on registration / reset.
  MIN_PASSWORD_LENGTH: 8
});
