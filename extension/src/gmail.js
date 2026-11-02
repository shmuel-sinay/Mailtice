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
    if (this.accessToken && !renew) return this.accessToken;
    // Several requests can find the token expired at once: one renewal serves them all.
    if (!this.renewing) {
      this.renewing = (async () => {
        try {
          await this.flow(false, "none");
        } catch {
          await this.flow(true, "");
        }
      })().finally(() => { this.renewing = null; });
    }
    await this.renewing;
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

/**
 * Gmail allows 250 quota units per user per second; a message or an attachment read costs 5.
 * Every request takes its units from here first, so the export runs right at the limit instead
 * of hitting it and being slowed down by 429 answers.
 */
export class QuotaLimiter {
  constructor(unitsPerSecond = 230) {
    this.rate = unitsPerSecond;
    this.tokens = unitsPerSecond;
    this.last = Date.now();
  }

  async take(units) {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.rate, this.tokens + ((now - this.last) / 1000) * this.rate);
      this.last = now;
      if (this.tokens >= units) {
        this.tokens -= units;
        return;
      }
      await sleep(Math.ceil(((units - this.tokens) / this.rate) * 1000));
    }
  }
}

/** Messages per batch request; Google suggests at most 50. */
export const BATCH_SIZE = 50;
const MESSAGE_UNITS = 5;

/**
 * The parts of a Gmail batch answer, by the Content-ID each request was sent with:
 * { status, body } with the body as text (JSON for a message).
 */
export function parseBatch(text, boundary) {
  const out = new Map();
  for (const part of text.split(`--${boundary}`)) {
    const id = part.match(/Content-ID:\s*<response-([^>\s]+)>/i);
    const status = part.match(/HTTP\/1\.1 (\d{3})/);
    if (!id || !status) continue;
    const after = part.slice(status.index);
    const gap = after.search(/\r?\n\r?\n/);
    out.set(id[1], { status: Number(status[1]), body: gap >= 0 ? after.slice(gap).trim() : "" });
  }
  return out;
}

export class GmailClient {
  constructor(auth, limiter = new QuotaLimiter()) {
    this.auth = auth;
    this.limiter = limiter;
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
      // Only the ids: the listing is the whole mailbox, page by page, so every byte saved counts.
      const params = { maxResults: "500", includeSpamTrash: String(includeSpamTrash), fields: "messages/id,nextPageToken" };
      if (q) params.q = q;
      if (pageToken) params.pageToken = pageToken;
      const page = await this.get("/messages", params);
      for (const m of page.messages || []) ids.push(m.id);
      pageToken = page.nextPageToken;
      if (onPage) onPage(ids.length);
    } while (pageToken);
    return ids;
  }

  /**
   * Up to [BATCH_SIZE] messages in full format with one HTTP request, in the order of `ids`; null
   * for one deleted meanwhile. One that Google answered with a rate limit or a server error is
   * fetched again on its own.
   */
  async messages(ids) {
    await this.limiter.take(ids.length * MESSAGE_UNITS);
    const boundary = `mailtice_${Math.random().toString(36).slice(2)}`;
    const body = ids.map((id, i) =>
      `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <m${i}>\r\n\r\n` +
      `GET /gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full\r\n\r\n`).join("") + `--${boundary}--`;
    let parts = null;
    for (let attempt = 0, wait = 1000; attempt < 6 && !parts; attempt++) {
      try {
        const response = await fetch("https://gmail.googleapis.com/batch/gmail/v1", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${await this.auth.token()}`,
            "Content-Type": `multipart/mixed; boundary=${boundary}`,
          },
          body,
        });
        if (response.status === 401) await this.auth.token(true);
        if (response.ok) {
          const answer = (response.headers.get("Content-Type") || "").match(/boundary=([^;\s]+)/);
          if (answer) parts = parseBatch(await response.text(), answer[1].replace(/"/g, ""));
        }
      } catch {
        // A dropped connection: the same wait as a rate limit, then again.
      }
      if (!parts) {
        await sleep(wait);
        wait = Math.min(wait * 2, 32000);
      }
    }
    if (!parts) return Promise.all(ids.map((id) => this.message(id)));
    return Promise.all(ids.map(async (id, i) => {
      const part = parts.get(`m${i}`);
      if (part && part.status === 200) {
        try {
          return JSON.parse(part.body);
        } catch {
          // A part cut short: read this one on its own.
        }
      }
      if (part && part.status === 404) return null;
      return this.message(id);
    }));
  }

  /** Full format: headers, labels and the MIME tree; null when it was deleted meanwhile. */
  async message(id) {
    await this.limiter.take(MESSAGE_UNITS);
    try {
      return await this.get(`/messages/${encodeURIComponent(id)}`, { format: "full" });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }

  async attachment(messageId, attachmentId) {
    await this.limiter.take(MESSAGE_UNITS);
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
