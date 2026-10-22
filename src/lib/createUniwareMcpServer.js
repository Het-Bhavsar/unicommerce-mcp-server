import fs from 'node:fs';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { getDefaultUniware } from './uniwareAuth.js';
import { collectResponseCodes } from './uniwareClient.js';

const apiManifest = JSON.parse(fs.readFileSync(new URL('../data/apiManifest.json', import.meta.url), 'utf8'));
const responseCodes = JSON.parse(fs.readFileSync(new URL('../data/responseCodes.json', import.meta.url), 'utf8'));

const SERVER_NAME = 'unicommerce-mcp-server';
const SERVER_VERSION = '1.1.0';

const CATEGORY_VALUES = [
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

const apiById = new Map(apiManifest.map((item) => [item.id, item]));
const responseCodeByCode = new Map(responseCodes.map((item) => [String(item.code), item.description]));

function toTextContent(value) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function filterCatalog({ category, search, includeWithoutEndpoint, limit }) {
  const query = search?.trim().toLowerCase() ?? '';

  const filtered = apiManifest.filter((item) => {
    if (category && item.category !== category) return false;
    if (!includeWithoutEndpoint && !item.endpoint && item.category !== 'Overview' && item.category !== 'Response Codes') {
      return false;
    }
    if (!query) return true;

    return (
      item.id.toLowerCase().includes(query) ||
      item.title.toLowerCase().includes(query) ||
      item.category.toLowerCase().includes(query) ||
      (item.endpoint || '').toLowerCase().includes(query)
    );
  });

  return filtered.slice(0, limit);
}

function responseCodeDetails(codes = []) {
  const deduped = [...new Set(codes.map((code) => String(code)))];
  return deduped
    .map((code) => ({
      code,
      description: responseCodeByCode.get(code) ?? null
    }))
    .filter((item) => item.description !== null);
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

function toIsoDate(value, field) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${field} must be an ISO 8601 date/time, got: ${value}`);
  }
  return parsed.toISOString();
}

function uniwareResult(result) {
  if (!result.ok) {
    throw new Error(`Uniware returned HTTP ${result.status}: ${JSON.stringify(result.data).slice(0, 2000)}`);
  }
  return toTextContent(result.data);
}

export function createUniwareMcpServer({ uniware = getDefaultUniware() } = {}) {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION
  });

  server.tool(
    'uniware_list_apis',
    'List Unicommerce Uniware API operations extracted from docs.',
    {
      category: z.enum(CATEGORY_VALUES).optional(),
      search: z.string().optional(),
      includeWithoutEndpoint: z.boolean().optional().default(false),
      limit: z.number().int().min(1).max(500).optional().default(200)
    },
    async (input) => {
      const items = filterCatalog(input);

      return toTextContent({
        total: items.length,
        items
      });
    }
  );

  server.tool(
    'uniware_get_api_details',
    'Get metadata for one Unicommerce Uniware API operation by id.',
    {
      apiId: z.string().min(1)
    },
    async ({ apiId }) => {
      const api = apiById.get(apiId);
      if (!api) {
        throw new Error(`Unknown apiId: ${apiId}`);
      }

      return toTextContent(api);
    }
  );

  server.tool(
    'uniware_lookup_response_code',
    'Look up Unicommerce response-code meaning by code.',
    {
      code: z.union([z.string(), z.number()])
    },
    async ({ code }) => {
      const codeKey = String(code);
      const description = responseCodeByCode.get(codeKey);

      if (!description) {
        return toTextContent({
          code: codeKey,
          found: false,
          description: null
        });
      }

      return toTextContent({
        code: codeKey,
        found: true,
        description
      });
    }
  );

  server.tool(
    'uniware_list_response_codes',
    'List known Unicommerce response codes with optional search.',
    {
      search: z.string().optional(),
      limit: z.number().int().min(1).max(1000).optional().default(200)
    },
    async ({ search, limit }) => {
      const query = search?.trim().toLowerCase() ?? '';

      const items = responseCodes
        .filter((item) => {
          if (!query) return true;
          return item.code.includes(query) || item.description.toLowerCase().includes(query);
        })
        .slice(0, limit);

      return toTextContent({
        total: items.length,
        items
      });
    }
  );

  server.tool(
    'uniware_call_api',
    'Execute a Uniware API request by apiId (preferred) or direct endpoint. Uses the relay\'s configured tenant, credentials and facility by default; baseUrl/subdomain/authToken/facility are optional overrides.',
    {
      apiId: z.string().optional(),
      baseUrl: z.string().url().optional(),
      subdomain: z.string().optional(),
      endpoint: z.string().optional(),
      method: z.string().optional(),
      query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
      headers: z.record(z.string()).optional(),
      body: z.any().optional(),
      authToken: z.string().optional(),
      facility: z.string().optional(),
      timeoutMs: z.number().int().min(1000).max(120000).optional().default(30000)
    },
    async ({ apiId, baseUrl, subdomain, endpoint, method, query, headers, body, authToken, facility, timeoutMs }) => {
      const selected = apiId ? apiById.get(apiId) : null;
      if (apiId && !selected) {
        throw new Error(`Unknown apiId: ${apiId}`);
      }

      const resolvedEndpoint = endpoint || selected?.endpoint;
      const resolvedMethod = (method || selected?.method || 'GET').toUpperCase();

      if (!resolvedEndpoint) {
        throw new Error('Endpoint not provided. Use endpoint directly or pick an apiId with a known endpoint.');
      }

      const result = await uniware.request({
        baseUrl,
        subdomain,
        endpoint: resolvedEndpoint,
        method: resolvedMethod,
        query,
        headers,
        body,
        authToken,
        facility,
        timeoutMs
      });

      const codes = collectResponseCodes(result.data, result.status);
      const mappedCodes = responseCodeDetails(codes);

      return toTextContent({
        request: {
          apiId: selected?.id ?? null,
          title: selected?.title ?? null,
          category: selected?.category ?? null,
          method: result.method,
          endpoint: resolvedEndpoint,
          baseUrl: result.baseUrl
        },
        response: {
          ok: result.ok,
          status: result.status,
          statusText: result.statusText,
          codeDetails: mappedCodes,
          data: result.data
        }
      });
    }
  );

  server.tool(
    'uniware_search_sale_orders',
    'Read-only. Search Uniware sale orders (POST /services/rest/v1/oms/saleOrder/search) with the relay\'s credentials. Filter by updatedSinceInMinutes, or fromDate/toDate (ISO 8601) on created or updated date, and status; page with displayStart/displayLength.',
    {
      updatedSinceInMinutes: z.number().int().min(1).optional(),
      fromDate: z.string().optional().describe('ISO 8601 date/time, inclusive lower bound'),
      toDate: z.string().optional().describe('ISO 8601 date/time, upper bound'),
      dateType: z.enum(['CREATED', 'UPDATED']).optional().describe('Which date fromDate/toDate filter on (Uniware default: CREATED)'),
      status: z.string().optional().describe('Sale order status, e.g. CREATED, PROCESSING, COMPLETE, CANCELLED'),
      displayStart: z.number().int().min(0).optional().default(0),
      displayLength: z.number().int().min(1).max(500).optional().default(50),
      facility: z.string().optional()
    },
    READ_ONLY,
    async ({ updatedSinceInMinutes, fromDate, toDate, dateType, status, displayStart, displayLength, facility }) => {
      const body = { searchOptions: { displayStart, displayLength, getCount: true } };
      if (updatedSinceInMinutes !== undefined) body.updatedSinceInMinutes = updatedSinceInMinutes;
      if (fromDate) body.fromDate = toIsoDate(fromDate, 'fromDate');
      if (toDate) body.toDate = toIsoDate(toDate, 'toDate');
      if (dateType) body.dateType = dateType;
      if (status) body.status = status;

      return uniwareResult(
        await uniware.request({ endpoint: '/services/rest/v1/oms/saleOrder/search', method: 'POST', body, facility })
      );
    }
  );

  server.tool(
    'uniware_inventory_snapshot',
    'Read-only. Get Uniware inventory snapshot (POST /services/rest/v1/inventory/inventorySnapshot/get) for the given SKUs and/or items updated in the last N minutes (max 1440).',
    {
      itemTypeSKUs: z.array(z.string().min(1)).max(10000).optional(),
      updatedSinceInMinutes: z.number().int().min(0).max(1440).optional(),
      facility: z.string().optional()
    },
    READ_ONLY,
    async ({ itemTypeSKUs, updatedSinceInMinutes, facility }) => {
      const body = {};
      if (itemTypeSKUs?.length) body.itemTypeSKUs = itemTypeSKUs;
      if (updatedSinceInMinutes !== undefined) body.updatedSinceInMinutes = updatedSinceInMinutes;

      return uniwareResult(
        await uniware.request({ endpoint: '/services/rest/v1/inventory/inventorySnapshot/get', method: 'POST', body, facility })
      );
    }
  );

  return server;
}
