# cr8or-google-ads

Google Ads MCP server for campaign management and reporting.

## Tools

The server exposes read-only reporting plus controlled mutation workflows. Mutations use validate → preview → explicit confirmation → apply and re-check current state before changing Google Ads.

### Read/reporting tools

- `list_accessible_customers`
- `get_account`
- `list_campaigns`
- `campaign_performance`
- `ad_group_performance`
- `keyword_performance`
- `search_terms`

### Controlled mutation tools

- Campaign status and daily budget
- Ad group status
- Keyword status

Raw Google Ads mutation primitives are not exposed to the MCP client.

## Authentication

The MCP endpoint supports two authentication paths:

1. `MCP_AUTH_TOKEN` for direct trusted service-to-service access.
2. MCP OAuth 2.1 for ChatGPT and other compatible MCP hosts.

OAuth is implemented as a small broker: Google authenticates the human user, while this server issues its own short-lived MCP access token bound to the `/mcp` resource. Google OAuth credentials are separate from the Google Ads API credentials.

### MCP OAuth environment

```text
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
OAUTH_SIGNING_SECRET=
OAUTH_ALLOWED_EMAILS=
OAUTH_ISSUER=https://cr8or-google-ads-production.up.railway.app
```

`OAUTH_ALLOWED_EMAILS` is a comma-separated allowlist of Google email addresses permitted to authorize the MCP server.

The Google OAuth web application must allow this redirect URI:

```text
https://cr8or-google-ads-production.up.railway.app/oauth/callback
```

ChatGPT's OAuth callback is not registered in Google. ChatGPT sends its own callback and client metadata to this MCP authorization server during the MCP OAuth flow.

### Google Ads API environment

```text
GOOGLE_ADS_CLIENT_ID=
GOOGLE_ADS_CLIENT_SECRET=
GOOGLE_ADS_DEVELOPER_TOKEN=
GOOGLE_ADS_REFRESH_TOKEN=
GOOGLE_ADS_CUSTOMER_ID=
GOOGLE_ADS_LOGIN_CUSTOMER_ID=
```

`GOOGLE_ADS_LOGIN_CUSTOMER_ID` is optional and is used when the target customer is accessed through a manager account.

## Local development

```bash
npm install
npm run dev
```

HTTP endpoints:

- `GET /health`
- `POST /mcp`
- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-authorization-server`
- `GET /oauth/authorize`
- `POST /oauth/token`
- `GET /oauth/callback`

The MCP endpoint accepts either `Authorization: Bearer <MCP_AUTH_TOKEN>` or an OAuth access token issued by this server.

## Railway

The service listens on `0.0.0.0` and uses Railway's `PORT` environment variable. Configure the Google Ads credentials, `MCP_AUTH_TOKEN`, and MCP OAuth variables before enabling the public MCP endpoint.
