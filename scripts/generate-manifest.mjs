import fs from 'node:fs/promises';

const DOCS_BASE = 'https://documentation.unicommerce.com';
const ROOT_DOC = '/docs/using-the-uniware-apis.html';

const CATEGORY_ORDER = [
  'Overview',
  'Authentication',
  'Inbound',
  'Product',
  'Inventory',
  'Sale Order',
  'Fulfillment',
  'Returns',
  'Outbound',
  'Facility',
  'Export Job',
  'Response Codes'
];

const WANTED_CATEGORIES = new Set(CATEGORY_ORDER);

const EXTRA_DOCS = [
  '/docs/response-codes.html',
  '/docs/authentication.html',
  '/docs/oauth.html',
  '/docs/oauth2.html',
  '/docs/oauth-refreshtoken.html',
  '/docs/pos-oauth.html',
  '/docs/pos-oauth-refreshtoken.html'
];

function unique(items) {
  return [...new Set(items)];
}

function decodeEntities(value = '') {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(html = '') {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '));
}

function pageDataUrl(path) {
  return `${DOCS_BASE}/page-data${path}/page-data.json`;
}

function endpointFromHtml(html) {
  const endpointMatch = html.match(/Endpoint:\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
  const methodMatch = html.match(/Request\s*Type:\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i);

  return {
    endpoint: endpointMatch ? stripTags(endpointMatch[1]) : null,
    method: methodMatch ? stripTags(methodMatch[1]).toUpperCase() : null
  };
}

function classifyCategory({ id, slug, sourcePath }) {
  const source = (sourcePath ?? '').replace(/\\/g, '/').toLowerCase();

  if (id === 'using-the-uniware-apis') return 'Overview';
  if (id === 'response-codes' || /response.?code/.test(source)) return 'Response Codes';

  if (/oauth|authentication/.test(id) || /_oauth_|_authentication_/.test(source)) return 'Authentication';

  if (/^customer-/.test(id) || /channel-mapping|vat-mapping/.test(id) || /_customer_|_channel_|_vat_/.test(source)) {
    return 'Inbound';
  }

  if (/_product_|_vendor_|_category_/.test(source) || /itemtype|vendor|category/.test(id)) {
    return 'Product';
  }

  if (
    /_shippingpackage_|_shippingmanifest_|_invoice_|_shipment_/.test(source) ||
    /shipping|invoice|allocateshippingprovider|alternateitem|sealid/.test(id)
  ) {
    return 'Fulfillment';
  }

  if (/_return_|reversepickup/.test(source) || /^return-/.test(id) || /reversepickup/.test(id)) {
    return 'Returns';
  }

  if (/_gatepass_/.test(source) || /gatepass/.test(id)) {
    return 'Outbound';
  }

  if (/_facility_|_picklist_|_batch_|inventorymovement/.test(source) || /facility|picklist|batch/.test(id)) {
    return 'Facility';
  }

  if (/_export_/.test(source) || /^export-/.test(id)) {
    return 'Export Job';
  }

  if (/_inventory_/.test(source) || /inventory|markfound/.test(id)) {
    return 'Inventory';
  }

  if (/_saleorder_/.test(source) || /^saleorder-/.test(id) || id === 'pos-saleorder-cancel') {
    return 'Sale Order';
  }

  return 'Other';
}

async function fetchRootLinks() {
  const html = await (await fetch(`${DOCS_BASE}${ROOT_DOC}`)).text();
  const links = html.match(/\/docs\/[a-z0-9-]+\.html/g) ?? [];
  return unique(links).sort();
}

async function fetchDoc(path) {
  const response = await fetch(pageDataUrl(path));
  if (!response.ok) return null;

  const json = await response.json();
  const node = json?.result?.data?.markdownRemark;
  if (!node) return null;

  const html = node.html ?? '';
  const { endpoint, method } = endpointFromHtml(html);

  return {
    id: path.replace('/docs/', '').replace('.html', ''),
    slug: path,
    title: node.frontmatter?.title ?? path,
    docsUrl: `${DOCS_BASE}${path}`,
    sourcePath: node.fields?.path ?? null,
    endpoint,
    method,
    html
  };
}

function parseResponseCodes(responseCodesHtml) {
  const rows = [...responseCodesHtml.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)];
  const items = [];

  for (const row of rows) {
    const cells = [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => stripTags(cell[1]));
    if (cells.length < 2) continue;
    if (!/^\d+$/.test(cells[0])) continue;

    items.push({
      code: cells[0],
      description: cells[1]
    });
  }

  const deduped = unique(items.map((item) => `${item.code}|||${item.description}`));
  return deduped.map((raw) => {
    const [code, description] = raw.split('|||');
    return { code, description };
  });
}

async function main() {
  const rootLinks = await fetchRootLinks();
  const allLinks = unique([...rootLinks, ...EXTRA_DOCS, ROOT_DOC]).sort();

  const docs = [];
  for (const path of allLinks) {
    const doc = await fetchDoc(path);
    if (doc) docs.push(doc);
  }

  const catalog = docs
    .map((doc) => ({
      id: doc.id,
      title: doc.title,
      category: classifyCategory(doc),
      docsUrl: doc.docsUrl,
      sourcePath: doc.sourcePath,
      endpoint: doc.endpoint,
      method: doc.method
    }))
    .filter((entry) => {
      if (!WANTED_CATEGORIES.has(entry.category)) return false;
      const isCoreDoc = ['using-the-uniware-apis', 'response-codes'].includes(entry.id);
      const isOverviewDoc = entry.id.endsWith('-overview') || entry.id === 'using-the-uniware-apis';
      if (entry.category === 'Authentication') return true;
      if (isCoreDoc || isOverviewDoc) return true;
      return Boolean(entry.endpoint || entry.method);
    });

  catalog.sort((a, b) => {
    const categoryDelta = CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
    if (categoryDelta !== 0) return categoryDelta;
    return a.title.localeCompare(b.title);
  });

  const responseCodesDoc = docs.find((doc) => doc.id === 'response-codes');
  const responseCodes = responseCodesDoc ? parseResponseCodes(responseCodesDoc.html) : [];

  await fs.writeFile(new URL('../src/data/apiManifest.json', import.meta.url), `${JSON.stringify(catalog, null, 2)}\n`);
  await fs.writeFile(new URL('../src/data/responseCodes.json', import.meta.url), `${JSON.stringify(responseCodes, null, 2)}\n`);

  const totals = catalog.reduce((acc, item) => {
    acc[item.category] = (acc[item.category] ?? 0) + 1;
    return acc;
  }, {});

  console.log(`catalog entries: ${catalog.length}`);
  console.log(`response codes: ${responseCodes.length}`);
  for (const category of CATEGORY_ORDER) {
    if (totals[category]) {
      console.log(`${category}: ${totals[category]}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
