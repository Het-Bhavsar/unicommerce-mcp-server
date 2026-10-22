import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createUniwareMcpServer } from '../src/lib/createUniwareMcpServer.js';
import {
  UniwareTokenManager,
  createUniwareContext,
  readUniwareConfig,
  resolveUniwareBaseUrl
} from '../src/lib/uniwareAuth.js';
import { FAKE_CREDS, startMockUniware } from './helpers.js';

function contextFor(baseUrl, extra = {}) {
  return createUniwareContext(readUniwareConfig({ UNICOMMERCE_TENANT: baseUrl, ...FAKE_CREDS, ...extra }));
}

test('base URL derivation from tenant', () => {
  assert.equal(resolveUniwareBaseUrl('acme'), 'https://acme.unicommerce.com');
  assert.equal(resolveUniwareBaseUrl('acme.unicommerce.com'), 'https://acme.unicommerce.com');
  assert.equal(resolveUniwareBaseUrl('https://acme.unicommerce.com/'), 'https://acme.unicommerce.com');
  assert.equal(resolveUniwareBaseUrl('http://127.0.0.1:9999//'), 'http://127.0.0.1:9999');
  assert.equal(resolveUniwareBaseUrl(''), null);

  const cfg = readUniwareConfig({ UNICOMMERCE_TENANT: 'acme', ...FAKE_CREDS });
  assert.equal(cfg.baseUrl, 'https://acme.unicommerce.com');
  assert.equal(cfg.clientId, 'my-trusted-client');
  assert.equal(cfg.facility, '01');
  assert.equal(cfg.configured, true);
  assert.equal(readUniwareConfig({ UNICOMMERCE_TENANT: 'acme', UNICOMMERCE_BASE_URL: 'https://x.example' }).baseUrl, 'https://x.example');
  assert.equal(readUniwareConfig({}).configured, false);
});

test('password grant params, cached token, Facility + auth headers', async () => {
  const mock = await startMockUniware((req, url) => {
    if (url.pathname === '/oauth/token') return { json: { access_token: 'tok-1', refresh_token: 'ref-1', expires_in: 3600 } };
    return { json: { successful: true } };
  });
  try {
    const uniware = contextFor(mock.baseUrl);
    await uniware.request({ endpoint: '/services/rest/v1/a', method: 'POST', body: { x: 1 } });
    await uniware.request({ endpoint: '/services/rest/v1/b', method: 'POST', body: {} });

    const [tokenReq] = mock.tokenRequests();
    assert.equal(mock.tokenRequests().length, 1, 'token is cached');
    assert.equal(tokenReq.method, 'GET');
    assert.deepEqual(tokenReq.query, {
      grant_type: 'password',
      client_id: 'my-trusted-client',
      username: FAKE_CREDS.UNICOMMERCE_USERNAME,
      password: FAKE_CREDS.UNICOMMERCE_PASSWORD
    });
    assert.equal(tokenReq.headers['content-type'], 'application/json');

    const api = mock.apiRequests()[0];
    assert.equal(api.headers.authorization, 'Bearer tok-1');
    assert.equal(api.headers.facility, '01');
    assert.equal(api.headers.accept, 'application/json');
    assert.deepEqual(api.body, { x: 1 });
  } finally {
    await mock.close();
  }
});

test('custom client id, facility env and per-call facility override', async () => {
  const mock = await startMockUniware((req, url) =>
    url.pathname === '/oauth/token' ? { json: { access_token: 't', expires_in: 3600 } } : { json: {} }
  );
  try {
    const uniware = contextFor(mock.baseUrl, { UNICOMMERCE_CLIENT_ID: 'custom-client', UNICOMMERCE_FACILITY: 'WH2' });
    await uniware.request({ endpoint: '/x' });
    await uniware.request({ endpoint: '/x', facility: 'WH9' });
    assert.equal(mock.tokenRequests()[0].query.client_id, 'custom-client');
    assert.equal(mock.apiRequests()[0].headers.facility, 'WH2');
    assert.equal(mock.apiRequests()[1].headers.facility, 'WH9');
  } finally {
    await mock.close();
  }
});

test('401 from API forces a refresh (refresh grant) and retries once', async () => {
  let tokenCount = 0;
  const mock = await startMockUniware((req, url) => {
    if (url.pathname === '/oauth/token') {
      tokenCount += 1;
      return { json: { access_token: `tok-${tokenCount}`, refresh_token: `ref-${tokenCount}`, expires_in: 3600 } };
    }
    if (req.headers.authorization === 'Bearer tok-1') return { status: 401, json: { error: 'invalid_token' } };
    return { json: { ok: true } };
  });
  try {
    const result = await contextFor(mock.baseUrl).request({ endpoint: '/services/rest/v1/x', method: 'POST', body: {} });
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { ok: true });
    const grants = mock.tokenRequests().map((r) => r.query.grant_type);
    assert.deepEqual(grants, ['password', 'refresh_token']);
    assert.equal(mock.tokenRequests()[1].query.refresh_token, 'ref-1');
    assert.equal(mock.apiRequests().length, 2);
    assert.equal(mock.apiRequests()[1].headers.authorization, 'Bearer tok-2');
  } finally {
    await mock.close();
  }
});

test('refresh grant failure falls back to password grant', async () => {
  const mock = await startMockUniware((req, url) => {
    if (url.searchParams.get('grant_type') === 'refresh_token') return { status: 400, json: { error: 'invalid_grant' } };
    return { json: { access_token: 'tok', refresh_token: 'ref', expires_in: 3600 } };
  });
  try {
    const manager = new UniwareTokenManager({ baseUrl: mock.baseUrl, username: 'u', password: 'p' });
    await manager.getToken();
    assert.equal(await manager.getToken({ forceRefresh: true }), 'tok');
    assert.deepEqual(
      mock.tokenRequests().map((r) => r.query.grant_type),
      ['password', 'refresh_token', 'password']
    );
  } finally {
    await mock.close();
  }
});

test('refreshes 5 minutes before expiry and single-flights concurrent refreshes', async () => {
  const mock = await startMockUniware(() => ({
    delayMs: 50,
    json: { access_token: 'tok', refresh_token: 'ref', expires_in: 600 }
  }));
  try {
    let now = 1_000_000;
    const manager = new UniwareTokenManager({ baseUrl: mock.baseUrl, username: 'u', password: 'p', now: () => now });
    const tokens = await Promise.all(Array.from({ length: 5 }, () => manager.getToken()));
    assert.deepEqual(new Set(tokens), new Set(['tok']));
    assert.equal(mock.tokenRequests().length, 1, 'concurrent callers share one request');

    now += 4 * 60 * 1000; // 6 min left: still fresh
    await manager.getToken();
    assert.equal(mock.tokenRequests().length, 1);

    now += 2 * 60 * 1000; // 4 min left: inside the 5 min window
    await Promise.all([manager.getToken(), manager.getToken()]);
    assert.equal(mock.tokenRequests().length, 2);
    assert.equal(mock.tokenRequests()[1].query.grant_type, 'refresh_token');
  } finally {
    await mock.close();
  }
});

test('"invalid email" HTTP 500 maps to a clear credentials error without leaking the password', async () => {
  const mock = await startMockUniware(() => ({
    status: 500,
    text: '{"error":"server_error","error_description":"Invalid email/username or password"}'
  }));
  try {
    const uniware = contextFor(mock.baseUrl);
    await assert.rejects(uniware.request({ endpoint: '/x' }), (error) => {
      assert.match(error.message, /Unicommerce rejected credentials/);
      assert.ok(!error.message.includes(FAKE_CREDS.UNICOMMERCE_PASSWORD));
      return true;
    });
    assert.equal(mock.apiRequests().length, 0);
  } finally {
    await mock.close();
  }
});

test('managed token is never sent to a caller-chosen host or off-tenant endpoint', async () => {
  const mock = await startMockUniware(() => ({ json: { access_token: 't', expires_in: 3600 } }));
  try {
    const uniware = contextFor(mock.baseUrl);
    await assert.rejects(uniware.request({ endpoint: '/x', baseUrl: 'https://evil.example' }), /pass authToken/);
    await assert.rejects(uniware.request({ endpoint: '//evil.example/x' }), /path on the Uniware base URL/);
    await assert.rejects(contextFor('').request({ endpoint: '/x' }), /base URL not configured/);
    await assert.rejects(
      createUniwareContext(readUniwareConfig({ UNICOMMERCE_TENANT: mock.baseUrl })).request({ endpoint: '/x' }),
      /credentials not configured/
    );
  } finally {
    await mock.close();
  }
});

test('MCP convenience tools map inputs onto the Uniware request bodies', async () => {
  const mock = await startMockUniware((req, url) => {
    if (url.pathname === '/oauth/token') return { json: { access_token: 'tok', expires_in: 3600 } };
    return { json: { successful: true, elements: [{ code: 'SO-1' }] } };
  });
  const server = createUniwareMcpServer({ uniware: contextFor(mock.baseUrl) });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const search = await client.callTool({
      name: 'uniware_search_sale_orders',
      arguments: { fromDate: '2026-10-01T00:00:00Z', toDate: '2026-10-02', status: 'COMPLETE' }
    });
    assert.ok(!search.isError, JSON.stringify(search));
    assert.deepEqual(JSON.parse(search.content[0].text), { successful: true, elements: [{ code: 'SO-1' }] });

    await client.callTool({ name: 'uniware_search_sale_orders', arguments: { updatedSinceInMinutes: 30 } });
    await client.callTool({
      name: 'uniware_inventory_snapshot',
      arguments: { itemTypeSKUs: ['SKU-1'], updatedSinceInMinutes: 60 }
    });
    const callApi = await client.callTool({
      name: 'uniware_call_api',
      arguments: { apiId: 'saleorder-search', body: { searchOptions: { displayLength: 1 } } }
    });
    assert.equal(JSON.parse(callApi.content[0].text).response.status, 200);

    const [s1, s2, inv, raw] = mock.apiRequests();
    assert.equal(s1.path, '/services/rest/v1/oms/saleOrder/search');
    assert.equal(s1.method, 'POST');
    assert.deepEqual(s1.body, {
      searchOptions: { displayStart: 0, displayLength: 50, getCount: true },
      fromDate: '2026-10-01T00:00:00.000Z',
      toDate: '2026-10-02T00:00:00.000Z',
      status: 'COMPLETE'
    });
    assert.equal(s2.body.updatedSinceInMinutes, 30);
    assert.equal(inv.path, '/services/rest/v1/inventory/inventorySnapshot/get');
    assert.deepEqual(inv.body, { itemTypeSKUs: ['SKU-1'], updatedSinceInMinutes: 60 });
    assert.equal(raw.headers.authorization, 'Bearer tok');

    const bad = await client.callTool({ name: 'uniware_inventory_snapshot', arguments: { updatedSinceInMinutes: 5000 } });
    assert.ok(bad.isError, 'updatedSinceInMinutes > 1440 rejected');
  } finally {
    await client.close();
    await mock.close();
  }
});
