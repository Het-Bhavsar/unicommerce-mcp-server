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
- `src/lib/uniwareAuth.js`: server-side Uniware login, token cache/refresh, Facility header
- `src/auth/`: OAuth 2.1 server (discovery, `/register`, `/authorize`, `/token`) and `/mcp` guard

## Setup

```bash
npm install
npm test
npm run build:manifest   # optional: refresh API data from docs
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

The relay logs in to Uniware itself (see [Secured relay deployment](#secured-relay-deployment)),
so tools work without passing `authToken`/`baseUrl`. Those parameters remain optional
per-call overrides; the relay's own token is only ever sent to the configured tenant.

HTTP mode settings:

- `MCP_TRANSPORT=http` (default when `PORT` is set, otherwise `stdio`)
- `PORT` / `MCP_HTTP_PORT` (default: `3000`)
- `MCP_HTTP_HOST` (default: `0.0.0.0`)
- `MCP_HTTP_PATH` (default: `/mcp`)

## Secured relay deployment

`railway.json` deploys this as a Railway service (`npm start`, health check `GET /health`).
`/mcp` requires auth; `/health` is public and returns only `{status, uniwareConfigured}`.

Environment variables (see `.env.example`):

| Variable | Required | Purpose |
| --- | --- | --- |
| `TEAM_API_KEY` | yes | Shared team access key. The server refuses to start in http mode without it. |
| `UNICOMMERCE_TENANT` | yes | Tenant name (`acme` → `https://acme.unicommerce.com`), host, or full URL |
| `UNICOMMERCE_USERNAME` / `UNICOMMERCE_PASSWORD` | yes | Uniware API user used for the server-side password grant |
| `UNICOMMERCE_CLIENT_ID` | no | OAuth client id (default `my-trusted-client`) |
| `UNICOMMERCE_FACILITY` | no | Default `Facility` header (default `01`); tools accept a `facility` override |
| `UNICOMMERCE_BASE_URL` | no | Overrides the base URL derived from the tenant |
| `OAUTH_SIGNING_SECRET` | no | JWT signing secret for OAuth tokens (default: HMAC-derived from `TEAM_API_KEY`) |
| `PUBLIC_BASE_URL` | no | Public URL of the relay (default: `https://$RAILWAY_PUBLIC_DOMAIN`, then request Host) |

Rotating `TEAM_API_KEY` (or `OAUTH_SIGNING_SECRET`) invalidates every issued OAuth token.

Connecting clients:

- **Claude.ai / Claude Desktop (custom connector)** or **Grok Bot (Cursor agents MCP)**: add the
  connector URL `https://<your-relay>/mcp`. The client discovers OAuth via
  `/.well-known/oauth-protected-resource`, registers itself, and opens a consent page — enter the
  **team access key** (`TEAM_API_KEY`) there. Allowed callbacks: `*.claude.ai`, `*.claude.com`,
  `*.anthropic.com`, `https://www.cursor.com/agents/mcp/oauth/callback`, and `localhost`.
- **Claude Code / curl / static-header clients**: send `Authorization: Bearer <TEAM_API_KEY>`:

  ```bash
  claude mcp add --transport http unicommerce https://<your-relay>/mcp \
    --header "Authorization: Bearer $TEAM_API_KEY"
  ```

## MCP Tools

1. `uniware_list_apis`
2. `uniware_get_api_details`
3. `uniware_call_api`
4. `uniware_lookup_response_code`
5. `uniware_list_response_codes`
6. `uniware_search_sale_orders` (read-only): `updatedSinceInMinutes`, `fromDate`/`toDate` (ISO 8601), `dateType`, `status`, `displayStart`/`displayLength`
7. `uniware_inventory_snapshot` (read-only): `itemTypeSKUs`, `updatedSinceInMinutes` (0–1440)

## Example Calls

Get sale-order APIs:

```json
{
  "category": "Sale Order"
}
```

Call create sale order via catalog id (relay credentials are used automatically):

```json
{
  "apiId": "saleorder-create",
  "body": {
    "saleOrder": {
      "code": "SO-1001"
    }
  }
}
```

Direct endpoint call against another tenant (explicit token required):

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
