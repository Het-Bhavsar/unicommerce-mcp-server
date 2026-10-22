import { callUniwareApi, normalizeBaseUrl, resolveUniwareBaseUrl } from './uniwareClient.js';

export { resolveUniwareBaseUrl };

// Server-side Uniware auth: the relay logs in with team credentials from env so
// MCP callers never handle Uniware tokens. Mirrors the HomeMate Python client:
// password grant, cached token refreshed 5 min before expiry (refresh grant
// first, password grant as fallback), single-flight refresh, 401 -> refresh
// and retry once. Tokens and passwords are never logged or put in errors.

export const DEFAULT_CLIENT_ID = 'my-trusted-client';
export const DEFAULT_FACILITY = '01';
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const TOKEN_TIMEOUT_MS = 30_000;

export class UniwareAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UniwareAuthError';
  }
}

export function readUniwareConfig(env = process.env) {
  const pick = (key) => (env[key] && env[key].trim() ? env[key].trim() : '');
  const baseUrl = resolveUniwareBaseUrl(pick('UNICOMMERCE_BASE_URL') || pick('UNICOMMERCE_TENANT'));
  const username = pick('UNICOMMERCE_USERNAME');
  const password = env.UNICOMMERCE_PASSWORD || '';
  return {
    baseUrl,
    username,
    password,
    clientId: pick('UNICOMMERCE_CLIENT_ID') || DEFAULT_CLIENT_ID,
    facility: pick('UNICOMMERCE_FACILITY') || DEFAULT_FACILITY,
    configured: Boolean(baseUrl && username && password)
  };
}

export class UniwareTokenManager {
  constructor({ baseUrl, clientId = DEFAULT_CLIENT_ID, username, password, now = Date.now }) {
    this.baseUrl = baseUrl;
    this.clientId = clientId;
    this.username = username;
    this.password = password;
    this.now = now;
    this.accessToken = null;
    this.refreshToken = null;
    this.expiresAt = 0;
    this.inflight = null;
  }

  /** Cached access token; refreshes when within 5 min of expiry or when forced. */
  async getToken({ forceRefresh = false } = {}) {
    if (!forceRefresh && this.accessToken && this.now() < this.expiresAt - REFRESH_SKEW_MS) {
      return this.accessToken;
    }
    // Single flight: concurrent callers share one refresh.
    if (!this.inflight) {
      this.inflight = this.#refresh().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  async #refresh() {
    if (this.refreshToken) {
      try {
        return this.#store(
          await this.#requestToken({
            grant_type: 'refresh_token',
            client_id: this.clientId,
            refresh_token: this.refreshToken
          })
        );
      } catch {
        // Fall through to a fresh password login.
        this.refreshToken = null;
      }
    }
    return this.#store(
      await this.#requestToken({
        grant_type: 'password',
        client_id: this.clientId,
        username: this.username,
        password: this.password
      })
    );
  }

  #store(data) {
    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token || null;
    const ttlSec = Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600;
    this.expiresAt = this.now() + ttlSec * 1000;
    return this.accessToken;
  }

  async #requestToken(params) {
    const url = new URL(`${this.baseUrl}/oauth/token`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    let res;
    let text;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS)
      });
      text = await res.text();
    } catch (error) {
      // Don't surface the URL: it carries the password as a query param.
      throw new UniwareAuthError(`Unicommerce token request failed: ${error?.name || 'network error'}`);
    }

    if (!res.ok && /invalid email/i.test(text)) {
      throw new UniwareAuthError(
        'Unicommerce rejected credentials (check UNICOMMERCE_USERNAME / UNICOMMERCE_PASSWORD / UNICOMMERCE_TENANT)'
      );
    }
    if (!res.ok) {
      throw new UniwareAuthError(`Unicommerce token request failed (HTTP ${res.status}, grant ${params.grant_type})`);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new UniwareAuthError('Unicommerce token response was not JSON');
    }
    if (!data?.access_token) {
      throw new UniwareAuthError('Unicommerce token response had no access_token');
    }
    return data;
  }
}

function hasHeader(headers, name) {
  return Object.keys(headers || {}).some((key) => key.toLowerCase() === name);
}

/**
 * Uniware request context: env-derived base URL + facility, plus a managed
 * token when credentials are configured. Per-call overrides stay possible.
 */
export function createUniwareContext(config = readUniwareConfig()) {
  const tokens = config.configured ? new UniwareTokenManager(config) : null;

  async function request({
    endpoint,
    method = 'GET',
    query,
    headers = {},
    body,
    baseUrl,
    subdomain,
    authToken,
    facility,
    timeoutMs
  }) {
    const overrideBase = baseUrl || subdomain ? normalizeBaseUrl({ baseUrl, subdomain }) : null;
    const target = overrideBase || config.baseUrl;
    if (!target) {
      throw new Error('Uniware base URL not configured. Set UNICOMMERCE_TENANT (or UNICOMMERCE_BASE_URL), or pass baseUrl.');
    }

    const useManagedToken = !authToken && !hasHeader(headers, 'authorization');
    if (useManagedToken) {
      if (!tokens) {
        throw new Error(
          'Uniware credentials not configured on the relay (UNICOMMERCE_TENANT/USERNAME/PASSWORD). Pass authToken to call directly.'
        );
      }
      if (target !== config.baseUrl) {
        // Never hand the relay's token to a host the caller picked.
        throw new Error('baseUrl/subdomain override differs from the configured tenant; pass authToken for that tenant.');
      }
    }

    const finalHeaders = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Facility: config.facility || DEFAULT_FACILITY
    };
    for (const [key, value] of Object.entries(headers || {})) {
      for (const existing of Object.keys(finalHeaders)) {
        if (existing.toLowerCase() === key.toLowerCase()) delete finalHeaders[existing];
      }
      finalHeaders[key] = value;
    }
    if (facility) {
      for (const existing of Object.keys(finalHeaders)) {
        if (existing.toLowerCase() === 'facility') delete finalHeaders[existing];
      }
      finalHeaders.Facility = facility;
    }

    const send = (token) =>
      callUniwareApi({ baseUrl: target, endpoint, method, query, headers: finalHeaders, body, authToken: token, timeoutMs });

    let result = await send(useManagedToken ? await tokens.getToken() : authToken);
    if (result.status === 401 && useManagedToken) {
      result = await send(await tokens.getToken({ forceRefresh: true }));
    }
    return { ...result, baseUrl: target };
  }

  return { baseUrl: config.baseUrl, facility: config.facility, configured: config.configured, tokens, request };
}

let defaultContext = null;

/** Lazily-built context from process.env, shared by all MCP sessions. */
export function getDefaultUniware() {
  defaultContext ??= createUniwareContext(readUniwareConfig());
  return defaultContext;
}
