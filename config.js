/**
 * Period Pass — site configuration
 *
 * Every value here is public by design. The HMAC signing key that makes passes
 * unforgeable stays in Apps Script Script Properties and must never appear in this repo.
 */
window.PASS_CONFIG = {

  // Apps Script web app URL, ending in /exec.
  // Deploy > New deployment > Web app, Execute as: Me, Who has access: Anyone.
  EXEC_URL: 'https://script.google.com/macros/s/PASTE_YOUR_DEPLOYMENT_ID/exec',

  // OAuth 2.0 Web application client ID from Google Cloud Console.
  // Authorised JavaScript origin must be exactly your Pages origin,
  // e.g. https://iitt-gac.github.io  (no path, no trailing slash).
  CLIENT_ID: 'PASTE_YOUR_CLIENT_ID.apps.googleusercontent.com',

  // Must match EVENT_CODE at the top of 00_Config.gs. Lets the scanner read a roll number
  // off a pass with no network, so the volunteer sees it instantly, and makes the scanner
  // refuse to start if the site and the backend are set to different semesters.
  EVENT_CODE: 'IITT-2026ODD',

  // Shown on the sign-in screen only.
  EVENT_NAME: 'IIT Tirupati — Class Attendance',

  // Milliseconds between decode attempts. Lower is faster and hotter on the battery.
  DECODE_INTERVAL_MS: 120,

  // How long to wait on the network before treating a scan as queued.
  REQUEST_TIMEOUT_MS: 10000,

  // How often the queue is flushed while scanning.
  SYNC_INTERVAL_MS: 6000
};
