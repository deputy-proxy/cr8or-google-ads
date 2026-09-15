# cr8or-google-ads

Google Ads MCP server for campaign management and reporting.

## Phase 1

Phase 1 is read-only. It provides an agent-oriented interface for account discovery and performance reporting without exposing mutation operations.

### Tools

- `list_accessible_customers`
- `get_account`
- `list_campaigns`
- `campaign_performance`
- `ad_group_performance`
- `keyword_performance`
- `search_terms`

Mutations are intentionally not implemented yet. The next phase will add controlled campaign, budget, ad group, ad and keyword mutations behind validation and confirmation-oriented workflows.

## Configuration

Set these environment variables:

```text
GOOGLE_ADS_CLIENT_ID=
GOOGLE_ADS_CLIENT_SECRET=
GOOGLE_ADS_DEVELOPER_TOKEN=
GOOGLE_ADS_REFRESH_TOKEN=
GOOGLE_ADS_CUSTOMER_ID=
GOOGLE_ADS_LOGIN_CUSTOMER_ID=
MCP_AUTH_TOKEN=
PORT=3000
```

`GOOGLE_ADS_LOGIN_CUSTOMER_ID` is optional and is used when the target customer is accessed through a manager account.

`MCP_AUTH_TOKEN` protects the remote MCP endpoint. Do not expose the Railway service without authentication.

## Local development

```bash
npm install
npm run dev
```

HTTP endpoints:

- `GET /health`
- `POST /mcp`

The MCP endpoint expects `Authorization: Bearer <MCP_AUTH_TOKEN>`.

## Railway

The service listens on `0.0.0.0` and uses Railway's `PORT` environment variable. Deploy the repository as a Node/Docker service and configure the environment variables above.
