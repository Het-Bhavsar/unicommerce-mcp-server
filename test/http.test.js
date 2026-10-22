import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { signJwt } from '../src/auth/jwt.js';
import { resolveSigningSecret } from '../src/auth/oauthServer.js';
import { createHttpApp, startHttpServer } from '../src/httpServer.js';
import { createUniwareContext, readUniwareConfig } from '../src/lib/uniwareAuth.js';

const TEAM_KEY = 'test-team-key-not-real';
const CURSOR_CALLBACK = 'https://www.cursor.com/agents/mcp/oauth/callback';

let relay;
let base;

before(async () => {
  // Explicit env: no Uniware creds, nothing inherited from the shell.
  relay = await startHttpServer({
    env: { TEAM_API_KEY: TEAM_KEY },
    port: 0,
    host: '127.0.0.1',
    uniware: createUniwareContext(readUniwareConfig({}))
  });
  base = `http://127.0.0.1:${relay.port}`;
});

after(async () => {
  await relay?.close();
});

async function mcpClient(token) {
  const client = new Client({ name: 'relay-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  });
  await client.connect(transport);
  return client;
}

function initializeRequest(headers = {}) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } }
    })
  });
}

function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

test('refuses to start in http mode without TEAM_API_KEY', async () => {
  assert.throws(() => createHttpApp({ env: {} }), /TEAM_API_KEY/);

  const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
  const child = spawn(process.execPath, [entry], {
    env: { PATH: process.env.PATH, PORT: '0' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 1);
  assert.match(stderr, /TEAM_API_KEY/);
});

test('/health is public and reveals only status + uniwareConfigured', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok', uniwareConfigured: false });
});

test('/mcp without auth -> 401 with WWW-Authenticate resource_metadata', async () => {
  for (const method of ['POST', 'GET', 'DELETE']) {
    const res = await fetch(`${base}/mcp`, { method });
    assert.equal(res.status, 401, method);
    assert.equal(
      res.headers.get('www-authenticate'),
      `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`
    );
  }
});

test('/mcp with wrong key or forged token -> 401', async () => {
  assert.equal((await initializeRequest({ Authorization: 'Bearer wrong-key' })).status, 401);
  assert.equal((await initializeRequest({ Authorization: 'Bearer a.b.c' })).status, 401);
  assert.equal((await initializeRequest({ Authorization: TEAM_KEY })).status, 401, 'Bearer scheme required');
});

test('/mcp with team key: initialize + tools/list includes the new tools', async () => {
  const client = await mcpClient(TEAM_KEY);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of [
      'uniware_list_apis',
      'uniware_get_api_details',
      'uniware_call_api',
      'uniware_lookup_response_code',
      'uniware_list_response_codes',
      'uniware_search_sale_orders',
      'uniware_inventory_snapshot'
    ]) {
      assert.ok(names.includes(name), `missing ${name}`);
    }
    const search = tools.find((t) => t.name === 'uniware_search_sale_orders');
    assert.equal(search.annotations?.readOnlyHint, true);

    // Unconfigured Uniware -> clear tool error, not a crash.
    const result = await client.callTool({ name: 'uniware_inventory_snapshot', arguments: {} });
    assert.ok(result.isError);
    assert.match(result.content[0].text, /not configured/);
  } finally {
    await client.close();
  }
});

test('OAuth discovery metadata', async () => {
  const pr = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
  assert.equal(pr.resource, `${base}/mcp`);
  assert.deepEqual(pr.authorization_servers, [base]);

  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.issuer, base);
  assert.equal(as.authorization_endpoint, `${base}/authorize`);
  assert.equal(as.token_endpoint, `${base}/token`);
  assert.equal(as.registration_endpoint, `${base}/register`);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
});

test('public base URL honours PUBLIC_BASE_URL / RAILWAY_PUBLIC_DOMAIN / X-Forwarded-Proto', async () => {
  const fwd = await (
    await fetch(`${base}/.well-known/oauth-protected-resource`, { headers: { 'X-Forwarded-Proto': 'https' } })
  ).json();
  assert.equal(fwd.resource, `https://127.0.0.1:${relay.port}/mcp`);

  for (const [env, expected] of [
    [{ PUBLIC_BASE_URL: 'https://relay.example.com/' }, 'https://relay.example.com'],
    [{ RAILWAY_PUBLIC_DOMAIN: 'uc-relay.up.railway.app' }, 'https://uc-relay.up.railway.app']
  ]) {
    const other = await startHttpServer({
      env: { TEAM_API_KEY: TEAM_KEY, ...env },
      port: 0,
      host: '127.0.0.1',
      uniware: createUniwareContext(readUniwareConfig({}))
    });
    try {
      const res = await fetch(`http://127.0.0.1:${other.port}/mcp`, { method: 'POST' });
      assert.equal(res.headers.get('www-authenticate'), `Bearer resource_metadata="${expected}/.well-known/oauth-protected-resource"`);
    } finally {
      await other.close();
    }
  }
});

test('full OAuth flow: register -> authorize (team key) -> token (PKCE) -> /mcp', async () => {
  const reg = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Grok Bot', redirect_uris: [CURSOR_CALLBACK] })
  });
  assert.equal(reg.status, 201);
  const { client_id } = await reg.json();
  assert.match(client_id, /^mcp-relay-/);

  const { verifier, challenge } = pkcePair();
  const params = {
    response_type: 'code',
    client_id,
    redirect_uri: CURSOR_CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz-state'
  };

  const page = await fetch(`${base}/authorize?${new URLSearchParams(params)}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  const html = await page.text();
  assert.match(html, /Team access key/);
  assert.match(html, /name="team_password"/);

  const post = (teamPassword) =>
    fetch(`${base}/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, team_password: teamPassword })
    });

  const wrong = await post('not-the-key');
  assert.equal(wrong.status, 401);
  assert.match(await wrong.text(), /Incorrect team access key/);

  const ok = await post(TEAM_KEY);
  assert.equal(ok.status, 302);
  const location = new URL(ok.headers.get('location'));
  assert.equal(`${location.origin}${location.pathname}`, CURSOR_CALLBACK);
  assert.equal(location.searchParams.get('state'), 'xyz-state');
  const code = location.searchParams.get('code');
  assert.ok(code);

  const exchange = (body) =>
    fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body)
    });

  const badPkce = await exchange({ grant_type: 'authorization_code', code, redirect_uri: CURSOR_CALLBACK, code_verifier: 'wrong' });
  assert.equal(badPkce.status, 400);

  // The failed attempt consumed the single-use code; get a fresh one.
  const ok2 = await post(TEAM_KEY);
  const code2 = new URL(ok2.headers.get('location')).searchParams.get('code');
  const tokenRes = await exchange({
    grant_type: 'authorization_code',
    code: code2,
    redirect_uri: CURSOR_CALLBACK,
    code_verifier: verifier,
    client_id
  });
  assert.equal(tokenRes.status, 200);
  const tokens = await tokenRes.json();
  assert.equal(tokens.token_type, 'Bearer');
  assert.ok(tokens.access_token && tokens.refresh_token);

  const replay = await exchange({ grant_type: 'authorization_code', code: code2, code_verifier: verifier });
  assert.equal(replay.status, 400, 'codes are single-use');

  const client = await mcpClient(tokens.access_token);
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === 'uniware_search_sale_orders'));
  } finally {
    await client.close();
  }

  // Refresh tokens mint new access tokens but are not themselves accepted on /mcp.
  assert.equal((await initializeRequest({ Authorization: `Bearer ${tokens.refresh_token}` })).status, 401);
  const refreshed = await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
  assert.equal(refreshed.status, 200);
  const { access_token } = await refreshed.json();
  assert.equal((await initializeRequest({ Authorization: `Bearer ${access_token}` })).status, 200);
});

test('/authorize rejects redirect URIs outside the allowlist and non-S256 PKCE', async () => {
  const { challenge } = pkcePair();
  const params = {
    response_type: 'code',
    client_id: 'c',
    code_challenge: challenge,
    code_challenge_method: 'S256'
  };
  for (const redirect_uri of ['https://evil.example/cb', 'https://www.cursor.com/other', 'http://claude.ai/cb']) {
    const res = await fetch(`${base}/authorize?${new URLSearchParams({ ...params, redirect_uri })}`);
    assert.equal(res.status, 400, redirect_uri);
  }
  for (const redirect_uri of ['https://claude.ai/api/mcp/auth_callback', 'http://localhost:6274/cb']) {
    const res = await fetch(`${base}/authorize?${new URLSearchParams({ ...params, redirect_uri })}`);
    assert.equal(res.status, 200, redirect_uri);
  }
  const plain = await fetch(
    `${base}/authorize?${new URLSearchParams({ ...params, redirect_uri: CURSOR_CALLBACK, code_challenge_method: 'plain' })}`
  );
  assert.equal(plain.status, 400);
});

test('access tokens signed with another secret or expired are rejected on /mcp', async () => {
  const claims = { sub: 'team', typ: 'access', scope: 'mcp' };
  assert.equal((await initializeRequest({ Authorization: `Bearer ${signJwt(claims, 'some-other-secret', 3600)}` })).status, 401);

  const realSecret = resolveSigningSecret({ teamApiKey: TEAM_KEY });
  assert.equal((await initializeRequest({ Authorization: `Bearer ${signJwt(claims, realSecret, -10)}` })).status, 401);
  assert.equal((await initializeRequest({ Authorization: `Bearer ${signJwt(claims, realSecret, 60)}` })).status, 200);
});
