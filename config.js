/**
 * Period Pass — site configuration
 *
 * Every value here is public by design. The HMAC signing key that makes passes
 * unforgeable stays in Apps Script Script Properties and must never appear in this repo.
 */
window.PASS_CONFIG = {

  // Apps Script web app URL, ending in /exec. Filled in.
  //
  // This must stay in step with the deployment: editing the Apps Script code changes nothing
  // for volunteers until you redeploy, and redeploying as a NEW DEPLOYMENT (rather than a new
  // version of the existing one) issues a different URL that must be pasted back here.
  // Deploy > Manage deployments > pencil > Version: New version keeps this URL valid.
  EXEC_URL: 'https://script.google.com/macros/s/AKfycbw01DXPzU0ouw5L6nvs2EVwzz8vOHt1d8X7A6-t-cdclGfNlmPXbrKdrYCc0X8f-gmt/exec',

  // OAuth 2.0 Web application client ID from Google Cloud Console. Filled in.
  // Authorised JavaScript origin must be exactly your Pages origin,
  // e.g. https://iitt-gac.github.io  (no path, no trailing slash).
  CLIENT_ID: '813055517806-0emc4nog3fv9jjc0u8sp8tboj66vlo82.apps.googleusercontent.com',

  // Must match EVENT_CODE at the top of 00_Config.gs. Lets the scanner read a roll number
  // off a pass with no network, so the volunteer sees it instantly, and makes the scanner
  // refuse to start if the site and the backend are set to different semesters.
  EVENT_CODE: 'IITT-2026-JulDec',

  // Shown on the sign-in screen only.
  EVENT_NAME: 'IIT Tirupati — Class Attendance',

  // Milliseconds between decode attempts. Lower is faster and hotter on the battery.
  DECODE_INTERVAL_MS: 120,

  // How long to wait on the network before treating a scan as queued.
  REQUEST_TIMEOUT_MS: 10000,

  // How long a forced photo check waits before recording as not checked.
  // Must match PHOTO_CHECK_WINDOW_MS in the Apps Script Config.
  PHOTO_CHECK_WINDOW_MS: 30000,

  // How often the queue is flushed while scanning.
  SYNC_INTERVAL_MS: 6000
};
