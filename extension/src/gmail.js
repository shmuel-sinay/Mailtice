// Google sign-in through the browser's own identity API, and the few Gmail API calls the export
// needs. Read-only scope: the extension never changes anything in the mailbox.

const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** The address Google must allow as a redirect for the OAuth client: https://<extension id>.chromiumapp.org/ */
export function redirectUrl() {
  return chrome.identity.getRedirectURL();
}

export class AuthError extends Error {
  constructor(code, detail = "") {
    super(code + (detail ? `: ${detail}` : ""));
    this.code = code;
  }
}

/**
 * An access token from Google's implicit flow. A token lasts an hour, longer than a big export,
 * so `token(true)` gets a fresh one quietly (Google remembers the consent) when the API says 401.
 */
export class GoogleAuth {
  constructor(clientId) {
    this.clientId = clientId;
    this.accessToken = null;
    this.email = "";
  }

  async signIn() {
    await this.flow(true, "select_account");
    return this.accessToken;
  }

  async token(renew = false) {
    if (!this.accessToken || renew) {
      try {
        await this.flow(false, "none");
      } catch {
        await this.flow(true, "");
      }
    }
    return this.accessToken;
  }

  async flow(interactive, prompt) {
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: "token",
      redirect_uri: redirectUrl(),
      scope: SCOPE,
      include_granted_scopes: "true",
    });
    if (prompt) params.set("prompt", prompt);
    if (this.email) params.set("login_hint", this.email);
    let result;
    try {
      result = await chrome.identity.launchWebAuthFlow({
        url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
        interactive,
      });
    } catch (e) {
      throw new AuthError("cancelled", String(e && e.message ? e.message : e));
    }
    const fragment = new URLSearchParams((result || "").split("#")[1] || "");
    const error = fragment.get("error") || new URLSearchParams((result || "").split("?")[1] || "").get("error");
    if (error) throw new AuthError(error);
    const token = fragment.get("access_token");
    if (!token) throw new AuthError("no_token");
    this.accessToken = token;
  }
}

export class ApiError extends Error {
  constructor(status, detail) {
    super(`Gmail API ${status}: ${detail}`);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class GmailClient {
  constructor(auth) {
    this.auth = auth;
  }

  /**
   * GET with retries: Gmail answers bursts with 429 (or 403 rateLimitExceeded) and the odd 5xx,
   * and a connection may drop - wait a little longer each time. A 401 renews the token once.
   */
  async get(path, params = {}) {
    const query = new URLSearchParams(params).toString();
    const url = `${API}${path}${query ? `?${query}` : ""}`;
    let wait = 1000;
    let renewed = false;
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetch(url, { headers: { Authorization: `Bearer ${await this.auth.token()}` } });
      } catch (e) {
        if (attempt >= 6) throw e;
        await sleep(wait);
        wait = Math.min(wait * 2, 32000);
        continue;
      }
      if (response.ok) return response.json();
      const text = await response.text();
      if (response.status === 401 && !renewed) {
        renewed = true;
        await this.auth.token(true);
        continue;
      }
      const limited = response.status === 429 || response.status >= 500 || (response.status === 403 && /rateLimit|userRateLimit/i.test(text));
      if (limited && attempt < 7) {
        await sleep(wait);
        wait = Math.min(wait * 2, 32000);
        continue;
      }
      throw new ApiError(response.status, text.slice(0, 300));
    }
  }

  profile() {
    return this.get("/profile");
  }

  async labels() {
    return (await this.get("/labels")).labels || [];
  }

  /** Every message id matching `q`, newest first. */
  async messageIds(q, includeSpamTrash, onPage) {
    const ids = [];
    let pageToken;
    do {
      const params = { maxResults: "500", includeSpamTrash: String(includeSpamTrash) };
      if (q) params.q = q;
      if (pageToken) params.pageToken = pageToken;
      const page = await this.get("/messages", params);
      for (const m of page.messages || []) ids.push(m.id);
      pageToken = page.nextPageToken;
      if (onPage) onPage(ids.length);
    } while (pageToken);
    return ids;
  }

  /** Full format: headers, labels and the MIME tree; null when it was deleted meanwhile. */
  async message(id) {
    try {
      return await this.get(`/messages/${encodeURIComponent(id)}`, { format: "full" });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }

  async attachment(messageId, attachmentId) {
    const body = await this.get(`/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
    return body.data || "";
  }
}

export function base64UrlDecode(data) {
  const normal = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normal + "=".repeat((4 - (normal.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
