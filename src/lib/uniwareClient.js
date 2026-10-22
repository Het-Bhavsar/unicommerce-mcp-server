const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Tenant -> base URL: full http(s) URL as-is; a dotted host gets https://;
 * a bare tenant name becomes https://<tenant>.unicommerce.com.
 */
export function resolveUniwareBaseUrl(tenant) {
  const raw = String(tenant ?? '').trim();
  if (!raw) return null;
  let url;
  if (/^https?:\/\//i.test(raw)) url = raw;
  else if (raw.includes('.')) url = `https://${raw}`;
  else url = `https://${raw}.unicommerce.com`;
  return url.replace(/\/+$/, '');
}

/** Explicit per-call base URL override (baseUrl wins over subdomain). */
export function normalizeBaseUrl({ baseUrl, subdomain } = {}) {
  const picked = resolveUniwareBaseUrl(baseUrl || subdomain);
  if (!picked) {
    throw new Error('Missing base URL. Provide baseUrl/subdomain or set UNICOMMERCE_TENANT.');
  }
  return picked;
}

export function buildUrl({ baseUrl, endpoint, query }) {
  if (!endpoint) {
    throw new Error('Missing endpoint path.');
  }

  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const url = new URL(normalizedEndpoint, `${baseUrl}/`);
  if (url.origin !== new URL(baseUrl).origin) {
    // e.g. endpoint "//evil.example/x" — never send credentials off-tenant.
    throw new Error('Endpoint must be a path on the Uniware base URL.');
  }

  if (query && typeof query === 'object') {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }

  return url;
}

function pickContentType(headers) {
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'content-type');
  return key ? headers[key] : '';
}

function tryParseBody(text, contentType) {
  if (!text) return null;

  const isJson = contentType.toLowerCase().includes('json');
  if (!isJson) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function collectResponseCodes(payload, status) {
  const found = new Set();

  if (status !== undefined && status !== null) {
    found.add(String(status));
  }

  const visit = (value) => {
    if (value === null || value === undefined) return;
    if (typeof value !== 'object') return;

    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    for (const [key, nested] of Object.entries(value)) {
      const lowerKey = key.toLowerCase();
      if ((lowerKey.includes('code') || lowerKey === 'status') && /^(\d{1,5})$/.test(String(nested))) {
        found.add(String(nested));
      }
      visit(nested);
    }
  };

  visit(payload);
  return [...found];
}

export async function callUniwareApi({
  baseUrl,
  endpoint,
  method = 'GET',
  query,
  headers = {},
  body,
  authToken,
  timeoutMs
}) {
  timeoutMs ??= DEFAULT_TIMEOUT_MS;
  const url = buildUrl({ baseUrl, endpoint, query });
  const upperMethod = method.toUpperCase();

  const finalHeaders = { ...headers };
  if (authToken && !Object.keys(finalHeaders).some((key) => key.toLowerCase() === 'authorization')) {
    finalHeaders.Authorization = `Bearer ${authToken}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const request = {
      method: upperMethod,
      headers: finalHeaders,
      signal: controller.signal
    };

    if (upperMethod !== 'GET' && upperMethod !== 'HEAD' && body !== undefined) {
      const contentType = pickContentType(finalHeaders);
      if (typeof body === 'string') {
        request.body = body;
      } else if (contentType.includes('application/x-www-form-urlencoded')) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(body || {})) {
          params.set(key, String(value));
        }
        request.body = params;
      } else {
        if (!contentType) {
          finalHeaders['Content-Type'] = 'application/json';
        }
        request.body = JSON.stringify(body);
      }
    }

    const response = await fetch(url, request);
    const text = await response.text();
    const responseContentType = response.headers.get('content-type') || '';
    const data = tryParseBody(text, responseContentType);

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      url: url.toString(),
      method: upperMethod,
      headers: Object.fromEntries(response.headers.entries()),
      data
    };
  } finally {
    clearTimeout(timeout);
  }
}
