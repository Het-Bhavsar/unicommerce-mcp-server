# Unicommerce Uniware MCP Server

Custom MCP server for Unicommerce Uniware APIs.

Unicommerce does not provide an official MCP server, so this project builds one using the official Model Context Protocol TypeScript SDK and Uniware public API docs.

This server exposes:

- API catalog by section (`Overview`, `Authentication`, `Inbound`, `Product`, `Inventory`, `Sale Order`, `Fulfillment`, `Returns`, `Outbound`, `Facility`, `Export Job`)
- API metadata lookup (endpoint + method + docs URL)
- Generic Uniware API execution tool
- Response code lookup based on Uniware response-code table
- Streamable HTTP transport for hosted deployments
- `stdio` transport for local MCP clients

## Source Docs

- https://documentation.unicommerce.com/docs/using-the-uniware-apis.html
- https://documentation.unicommerce.com/docs/response-codes.html

## Project Structure

- `scripts/generate-manifest.mjs`: Scrapes docs and regenerates:
  - `src/data/apiManifest.json`
  - `src/data/responseCodes.json`
- `src/index.js`: MCP server entry (mode switch)
- `src/httpServer.js`: Streamable HTTP MCP transport
- `src/lib/createUniwareMcpServer.js`: MCP tool registration
- `src/lib/uniwareClient.js`: HTTP and response-code helper logic

## Setup

```bash
npm install
npm run build:manifest
```

## Run Modes

Local `stdio` mode:

```bash
npm run start:stdio
```

Hosted Streamable HTTP mode:

```bash
npm run start:http
```

The HTTP MCP endpoint is `POST/GET/DELETE /mcp`.

Health check:

```bash
GET /health
```

## Environment

Set one of the following:

- `UNICOMMERCE_BASE_URL` (recommended), e.g. `https://{tenant}.unicommerce.com`
- or pass `baseUrl`/`subdomain` in `uniware_call_api`

HTTP mode settings:

- `MCP_TRANSPORT=http`
- `MCP_HTTP_HOST` (default: `0.0.0.0`)
- `MCP_HTTP_PORT` (default: `3000`)
- `MCP_HTTP_PATH` (default: `/mcp`)

## MCP Tools

1. `uniware_list_apis`
2. `uniware_get_api_details`
3. `uniware_call_api`
4. `uniware_lookup_response_code`
5. `uniware_list_response_codes`

## Example Calls

Get sale-order APIs:

```json
{
  "category": "Sale Order"
}
```

Call create sale order via catalog id:

```json
{
  "apiId": "saleorder-create",
  "authToken": "<token>",
  "body": {
    "saleOrder": {
      "code": "SO-1001"
    }
  }
}
```

Direct endpoint call:

```json
{
  "baseUrl": "https://tenant.unicommerce.com",
  "endpoint": "/services/rest/v1/oms/saleOrder/get",
  "method": "POST",
  "authToken": "<token>",
  "body": {
    "saleOrderCode": "SO-1001"
  }
}
```

## Refreshing For Latest Docs

Run:

```bash
npm run build:manifest
```

This re-scrapes docs and updates API/response-code datasets.
