import express from 'express';
import { createHmac } from 'node:crypto';

import { constantTimeEq, randomToken, sha256base64url, signJwt, verifyJwt } from './jwt.js';

// OAuth 2.1 authorization server fronting /mcp (ported from the adsrelay
// reference). Lets Claude.ai custom connectors / Grok Bot (Cursor agents)
// connect via OAuth, where the human enters the shared team access key on the
// consent page. `Authorization: Bearer <TEAM_API_KEY>` keeps working directly.
//
// Flow: client hits /mcp unauthenticated -> 401 + WWW-Authenticate -> reads
// /.well-known/* -> POST /register (DCR) -> /authorize (team key) ->
// POST /token (auth code + PKCE S256) -> calls /mcp with the issued JWT.

export const ACCESS_TTL_SEC = 60 * 60; // 1 hour
export const REFRESH_TTL_SEC = 30 * 24 * 60 * 60; // 30 days
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_CODES = 1000;

// Exact (non-Claude) callback URIs that are also trusted — matched on the full
// URI so nothing else on these domains can receive a code.
const EXTRA_ALLOWED_REDIRECTS = new Set([
  // Grok Bot / Cursor agents MCP connector OAuth callback
  'https://www.cursor.com/agents/mcp/oauth/callback'
]);
const ALLOWED_REDIRECT_DOMAINS = ['claude.ai', 'claude.com', 'anthropic.com'];

export function isAllowedRedirect(uri) {
  if (EXTRA_ALLOWED_REDIRECTS.has(uri)) return true;
  let u;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) {
    return true;
  }
  if (u.protocol !== 'https:') return false;
  return ALLOWED_REDIRECT_DOMAINS.some((d) => u.hostname === d || u.hostname.endsWith(`.${d}`));
}

/** Signing secret: OAUTH_SIGNING_SECRET, else derived from TEAM_API_KEY via HMAC. */
export function resolveSigningSecret({ signingSecret, teamApiKey }) {
  if (signingSecret) return signingSecret;
  return createHmac('sha256', teamApiKey).update('unicommerce-relay-oauth-signing-v1').digest('base64url');
}

/**
 * Public origin of this relay: PUBLIC_BASE_URL, else RAILWAY_PUBLIC_DOMAIN
 * (https), else derived from the request Host / X-Forwarded-Proto.
 */
export function publicBaseUrl(req, env = process.env) {
  if (env.PUBLIC_BASE_URL) return env.PUBLIC_BASE_URL.trim().replace(/\/+$/, '');
  if (env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${env.RAILWAY_PUBLIC_DOMAIN.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
  }
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = forwarded || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return `${proto}://${String(host).split(',')[0].trim()}`;
}

function bearerToken(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function cors(_req, res, next) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Protocol-Version');
  next();
}

/**
 * Mount the OAuth endpoints on `app` and return a `requireAuth` middleware
 * for the MCP route.
 */
export function installOAuth(app, { teamApiKey, signingSecret, mcpPath = '/mcp', env = process.env }) {
  if (!teamApiKey) throw new Error('installOAuth: teamApiKey is required');
  const secret = resolveSigningSecret({ signingSecret, teamApiKey });

  // code -> { codeChallenge, redirectUri, exp }. Codes live seconds, so
  // in-memory is fine for a single Railway instance.
  const authCodes = new Map();
  const sweepCodes = () => {
    const now = Date.now();
    for (const [code, entry] of authCodes) {
      if (entry.exp < now) authCodes.delete(code);
    }
  };

  const base = (req) => publicBaseUrl(req, env);

  const issueTokens = (req) => {
    const b = base(req);
    return {
      access_token: signJwt({ iss: b, aud: `${b}${mcpPath}`, sub: 'team', typ: 'access', scope: 'mcp' }, secret, ACCESS_TTL_SEC),
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_SEC,
      refresh_token: signJwt({ iss: b, sub: 'team', typ: 'refresh' }, secret, REFRESH_TTL_SEC),
      scope: 'mcp'
    };
  };

  const verifyTyped = (token, typ) => {
    const payload = verifyJwt(token, secret);
    if (payload.typ !== typ) throw new Error(`not a ${typ} token`);
    return payload;
  };

  const protectedResource = (req) => ({
    resource: `${base(req)}${mcpPath}`,
    authorization_servers: [base(req)],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp']
  });

  const authServerMetadata = (req) => {
    const b = base(req);
    return {
      issuer: b,
      authorization_endpoint: `${b}/authorize`,
      token_endpoint: `${b}/token`,
      registration_endpoint: `${b}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp']
    };
  };

  // --- Discovery (RFC 9728 / RFC 8414) ---------------------------------------
  for (const path of ['/.well-known/oauth-protected-resource', `/.well-known/oauth-protected-resource${mcpPath}`]) {
    app.get(path, cors, (req, res) => res.json(protectedResource(req)));
  }
  for (const path of [
    '/.well-known/oauth-authorization-server',
    `/.well-known/oauth-authorization-server${mcpPath}`,
    '/.well-known/openid-configuration'
  ]) {
    app.get(path, cors, (req, res) => res.json(authServerMetadata(req)));
  }

  const form = express.urlencoded({ extended: false, limit: '16kb' });

  // --- Dynamic Client Registration (RFC 7591), stateless ---------------------
  // Security comes from PKCE + the redirect allowlist, not a client registry.
  app.options('/register', cors, (_req, res) => res.sendStatus(204));
  app.post('/register', cors, (req, res) => {
    const meta = req.body && typeof req.body === 'object' ? req.body : {};
    res.status(201).json({
      client_id: `mcp-relay-${randomToken(12)}`,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: Array.isArray(meta.redirect_uris) ? meta.redirect_uris : [],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: typeof meta.client_name === 'string' ? meta.client_name : 'MCP Client'
    });
  });

  // --- Authorization endpoint ------------------------------------------------
  const validateAuthzParams = (p) => {
    if (p.response_type !== 'code') return 'response_type must be "code"';
    if (!p.client_id) return 'missing client_id';
    if (!p.redirect_uri || !isAllowedRedirect(String(p.redirect_uri))) {
      if (p.redirect_uri) console.warn('[auth] rejected redirect_uri:', String(p.redirect_uri).slice(0, 200));
      return 'redirect_uri is missing or not an allowed callback';
    }
    if (!p.code_challenge) return 'missing code_challenge (PKCE is required)';
    if (p.code_challenge_method !== 'S256') return 'code_challenge_method must be S256';
    return null;
  };

  app.get('/authorize', (req, res) => {
    const err = validateAuthzParams(req.query);
    if (err) return res.status(400).type('text/plain').send(`invalid_request: ${err}`);
    sendConsent(res, 200, req.query, null);
  });

  app.post('/authorize', form, (req, res) => {
    const body = req.body || {};
    const err = validateAuthzParams(body);
    if (err) return res.status(400).type('text/plain').send(`invalid_request: ${err}`);

    if (!constantTimeEq(String(body.team_password || ''), teamApiKey)) {
      return sendConsent(res, 401, body, 'Incorrect team access key. Try again.');
    }

    sweepCodes();
    if (authCodes.size >= MAX_PENDING_CODES) {
      return res.status(503).type('text/plain').send('temporarily_unavailable: too many pending authorizations');
    }
    const code = randomToken(24);
    authCodes.set(code, {
      codeChallenge: String(body.code_challenge),
      redirectUri: String(body.redirect_uri),
      exp: Date.now() + CODE_TTL_MS
    });

    const redirect = new URL(String(body.redirect_uri));
    redirect.searchParams.set('code', code);
    if (body.state) redirect.searchParams.set('state', String(body.state));
    res.redirect(302, redirect.toString());
  });

  // --- Token endpoint --------------------------------------------------------
  app.options('/token', cors, (_req, res) => res.sendStatus(204));
  app.post('/token', cors, form, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const body = req.body || {};
    const tokenError = (description) =>
      res.status(400).json({ error: 'invalid_grant', error_description: description });

    if (body.grant_type === 'authorization_code') {
      sweepCodes();
      const code = body.code ? String(body.code) : '';
      const entry = authCodes.get(code);
      if (!entry) return tokenError('unknown or expired code');
      authCodes.delete(code); // single use
      if (entry.exp < Date.now()) return tokenError('code expired');
      if (body.redirect_uri && String(body.redirect_uri) !== entry.redirectUri) {
        return tokenError('redirect_uri mismatch');
      }
      const verifier = body.code_verifier ? String(body.code_verifier) : '';
      if (!verifier || !constantTimeEq(sha256base64url(verifier), entry.codeChallenge)) {
        return tokenError('PKCE verification failed');
      }
      return res.json(issueTokens(req));
    }

    if (body.grant_type === 'refresh_token') {
      try {
        verifyTyped(String(body.refresh_token || ''), 'refresh');
      } catch {
        return tokenError('invalid refresh_token');
      }
      return res.json(issueTokens(req));
    }

    return res.status(400).json({ error: 'unsupported_grant_type' });
  });

  // --- Guard for the MCP route ----------------------------------------------
  return function requireAuth(req, res, next) {
    const token = bearerToken(req);
    let ok = false;
    if (token) {
      if (constantTimeEq(token, teamApiKey)) {
        ok = true;
      } else {
        try {
          verifyTyped(token, 'access');
          ok = true;
        } catch {
          ok = false;
        }
      }
    }
    if (ok) return next();

    res.set('WWW-Authenticate', `Bearer resource_metadata="${base(req)}/.well-known/oauth-protected-resource"`);
    res.status(401).json({
      error: 'unauthorized',
      hint: 'Use Authorization: Bearer <TEAM_API_KEY> or complete the OAuth flow'
    });
  };
}

// --- Consent screen ----------------------------------------------------------
function sendConsent(res, status, params, error) {
  // The page collects the team key: never cache it and never allow framing.
  res.set('Cache-Control', 'no-store');
  res.set('X-Frame-Options', 'DENY');
  res.set('Content-Security-Policy', "frame-ancestors 'none'");
  res.status(status).type('html').send(consentPage(params, error));
}

const CARRIED_PARAMS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'code_challenge',
  'code_challenge_method',
  'state',
  'scope',
  'resource'
];

function consentPage(params, error) {
  const hidden = CARRIED_PARAMS.filter((k) => params[k] != null)
    .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(String(params[k]))}">`)
    .join('\n    ');
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect — Unicommerce MCP Relay</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;max-width:420px;margin:72px auto;padding:0 24px;line-height:1.5">
  <h2 style="margin-bottom:4px">Unicommerce MCP Relay</h2>
  <p style="color:#555;margin-top:0">Enter your team access key to connect this client.</p>
  ${error ? `<p style="color:#c0392b;font-size:14px">${escapeHtml(error)}</p>` : ''}
  <form method="POST" action="/authorize">
    ${hidden}
    <input type="password" name="team_password" placeholder="Team access key" autofocus required
      style="width:100%;padding:11px;font-size:14px;box-sizing:border-box;border:1px solid #ccc;border-radius:8px">
    <button type="submit"
      style="margin-top:12px;width:100%;padding:11px;font-size:14px;font-weight:600;cursor:pointer;border:0;border-radius:8px;background:#1a1a1a;color:#fff">
      Connect
    </button>
  </form>
  <p style="color:#999;font-size:12px;margin-top:20px">
    This grants the connecting client shared access to your team's Unicommerce (Uniware) connection.
  </p>
</body></html>`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
