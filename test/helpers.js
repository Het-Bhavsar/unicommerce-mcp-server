import http from 'node:http';

/**
 * Local fake Uniware server. `handler(req, url, body)` returns
 * `{ status, json | text, delayMs }`. Every request is recorded.
 */
export async function startMockUniware(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://mock');
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });

    const out = (await handler(req, url, body)) || { status: 404, json: { error: 'not found' } };
    if (out.delayMs) await new Promise((r) => setTimeout(r, out.delayMs));
    res.statusCode = out.status ?? 200;
    if (out.text !== undefined) {
      res.setHeader('Content-Type', 'text/plain');
      res.end(out.text);
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(out.json ?? {}));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,
    requests,
    tokenRequests: () => requests.filter((r) => r.path === '/oauth/token'),
    apiRequests: () => requests.filter((r) => r.path !== '/oauth/token'),
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

export const FAKE_CREDS = {
  UNICOMMERCE_USERNAME: 'fake-user@example.com',
  UNICOMMERCE_PASSWORD: 'fake-password-123'
};
