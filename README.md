# cr8or-google-ads

Google Ads MCP server for campaign management, reporting, auditing, and controlled optimization.

## Capability model

The project is organized around advertising capabilities rather than exposing raw Google Ads API resources. Mutations use validate → preview → explicit confirmation → apply and re-check current state before changing Google Ads.

The roadmap below is deliberately capability-oriented. Google Ads exposes a very large number of resources and fields; implementing every API resource verbatim would produce a worse MCP interface rather than a better one.

## Development roadmap

### Phase 0 — Foundation and architecture

**Status: Completed**

Establish the MCP server, authentication, Google Ads client, controlled mutation workflow, CI, and capability-oriented tool composition.

Scope:

- MCP HTTP endpoint and OAuth 2.1 broker
- Google Ads OAuth/client integration
- Accessible customer discovery
- Validate → preview → confirm → apply mutation workflow
- Current-state revalidation immediately before mutation
- Structured Google Ads mutation errors
- Explicit MCP capability composition
- CI typecheck and build

### Phase 1 — Account and Search campaign observability

**Status: Completed**

Provide the read-only information required to understand a Search account before making changes.

Scope:

- Account/customer identity and settings
- Accessible customer listing
- Campaign listing
- Campaign performance
- Ad-group performance
- Keyword performance
- Search-term reporting
- Core campaign, ad-group, keyword, and search-term metrics

### Phase 2 — Core Search campaign mutations

**Status: Completed / In progress**

Provide safe control over the fundamental Search campaign hierarchy.

Scope:

- Campaign enable/pause
- Campaign daily budget
- Campaign bidding strategy
- Manual CPC
- Maximize Conversions
- Maximize Conversion Value
- Target CPA
- Target ROAS
- Ad-group creation
- Ad-group enable/pause
- Ad-group bidding
- Positive keyword creation
- Keyword enable/pause
- Keyword removal
- Keyword moves between ad groups
- Ad-group and campaign negative keywords
- Negative keyword removal
- Ad enable/pause
- Ad removal

### Phase 3 — Conversion tracking and campaign goals

**Status: Partially completed**

Make conversion configuration a first-class capability instead of treating it as an implementation detail of campaign optimization.

Scope:

- Read conversion actions
- Inspect conversion categories and origins
- Campaign conversion-goal inspection
- Configure campaign conversion goals
- Enable/disable campaign goal biddability
- Reset campaign goals to customer defaults
- Create custom conversion goals
- Attach custom conversion goals to campaigns
- Manage conversion action primary/secondary configuration
- Create, update, and remove conversion actions where supported
- Make custom-goal operations idempotent
- Improve diagnostics for conversion mutations

Current implementation includes campaign goal configuration, reset-to-customer behavior, and custom conversion-goal workflows. The custom conversion-goal live mutation still requires root-cause verification before this phase can be considered complete.

### Phase 4 — Ads and Responsive Search Ads lifecycle

**Status: Partially completed**

Turn ad management into a complete lifecycle rather than primarily a creation/status capability.

Scope:

- Read ads
- Create Responsive Search Ads
- Validate RSA definitions
- Update Responsive Search Ads
- Pause/enable ads
- Remove ads
- Duplicate-ad detection
- Ad-level performance reporting
- Support additional relevant Search ad types where appropriate

### Phase 5 — Campaign targeting and configuration

**Status: Not started**

Expose the configuration that determines where, when, and to whom a Search campaign can run.

Scope:

- Campaign targeting inspection
- Add/remove locations
- Location bid adjustments where applicable
- Language targeting
- Network configuration
- Ad schedules
- Device-related configuration where applicable
- Audience targeting and exclusions
- Campaign-level configuration inspection and mutation

### Phase 6 — Assets

**Status: Not started**

Build a reusable asset capability shared by campaigns and ad groups.

Scope:

- Asset discovery
- Create assets
- Update assets
- Remove assets
- Associate assets with campaigns
- Associate assets with ad groups
- Remove associations
- Sitelinks
- Callouts
- Structured snippets
- Images
- Logos
- Asset performance reporting

### Phase 7 — Audiences

**Status: Not started**

Provide audience targeting and exclusion as a dedicated capability.

Scope:

- Audience discovery
- Audience targeting
- Audience exclusions
- Remarketing audiences
- Customer Match where supported and appropriate
- Audience performance reporting

### Phase 8 — Reporting and optimization intelligence

**Status: Partially completed**

Expand reporting from basic performance tables into the data required for systematic optimization.

Scope:

- Device segmentation
- Geographic segmentation
- Day/hour segmentation
- Network segmentation
- Asset performance
- Landing-page performance
- Conversion segmentation
- Search-term trends
- Search-term insight categories
- Bid and performance diagnostics
- Cross-level performance analysis

Existing campaign auditing and search-term analysis belong to this phase and are already implemented in part.

### Phase 9 — Campaign restructuring and optimization workflows

**Status: Completed / expanding**

Turn low-level mutations into high-level, auditable optimization workflows.

Scope:

- Campaign structural audits
- Keyword clustering/restructuring
- Destination ad-group creation
- Atomic keyword moves
- Atomic restructure operations
- RSA creation during restructuring
- Signed confirmation plans
- Non-partial-failure grouped mutations
- Pre-apply state revalidation
- Optimization recommendations
- Bulk optimization workflows
- Idempotent optimization plans

The current implementation already supports campaign restructuring with destination ad-group creation, keyword movement, and atomic RSA creation.

### Phase 10 — Labels, shared sets, and reusable campaign infrastructure

**Status: Not started**

Add reusable organizational primitives needed for larger accounts.

Scope:

- Create/update/remove labels
- Assign labels to campaigns
- Assign labels to ad groups
- Assign labels to keywords and other supported resources
- Create shared negative keyword lists
- Add/remove keywords from shared sets
- Attach shared sets to campaigns
- Remove shared-set associations

### Phase 11 — Bid strategies and advanced bidding

**Status: Not started**

Expand bidding beyond campaign-level strategy selection.

Scope:

- Read bid strategies
- Portfolio bid strategies
- Create/update/remove supported portfolio strategies
- Bid strategy configuration
- Bid simulations
- Bidding diagnostics
- Strategy performance reporting

### Phase 12 — Experiments and controlled testing

**Status: Not started**

Provide an explicit experimentation capability for testing campaign changes without treating production campaigns as a laboratory bench.

Scope:

- Campaign drafts
- Campaign experiments
- Experiment arms
- Experiment configuration
- Experiment metrics
- Experiment comparison
- Controlled promotion of successful configurations where supported

### Phase 13 — Performance Max

**Status: Not started**

Add Performance Max as a distinct capability family rather than forcing it into the Search campaign model.

Scope:

- Asset groups
- Asset-group assets
- Asset-group signals
- Listing groups
- PMax campaign configuration
- PMax reporting
- PMax optimization workflows

### Phase 14 — Shopping

**Status: Not started**

Support Shopping-specific campaign structures and product-based optimization.

Scope:

- Shopping campaign management
- Product groups
- Listing/product reporting
- Shopping targeting
- Shopping performance analysis
- Shopping optimization workflows

Merchant Center feed management remains outside the core Google Ads API capability and should be handled as a separate integration if needed.

### Phase 15 — Keyword research and planning

**Status: Not started**

Add planning capabilities that can inform campaign construction before mutations are made.

Scope:

- Keyword ideas
- Historical keyword metrics
- Keyword forecasts
- Keyword plan creation
- Keyword-plan metrics
- Research workflows that feed campaign restructuring and creation

### Phase 16 — Account-scale automation and governance

**Status: Not started**

Move from individual optimization actions toward safe account-scale operations.

Scope:

- Bulk operations across campaigns
- Bulk operations across ad groups and keywords
- Idempotent plans
- Dry-run and impact summaries
- Change journals
- Rollback-oriented plans where the API permits
- Permission and capability checks
- Rate-limit aware batching
- Mutation safety limits
- Audit trails

## Capability coverage today

| Capability family | Current state |
|---|---|
| Account discovery and inspection | **Implemented** |
| Search campaign reporting | **Implemented** |
| Search campaign basic mutations | **Implemented** |
| Ad-group management | **Implemented** |
| Keyword management | **Implemented** |
| Negative keywords | **Implemented** |
| Ad lifecycle | **Partially implemented** |
| Responsive Search Ads | **Partially implemented** |
| Conversion goals | **Partially implemented** |
| Campaign auditing | **Implemented** |
| Search-term analysis | **Implemented** |
| Campaign restructuring | **Implemented** |
| Atomic restructure + RSA creation | **Implemented** |
| Campaign targeting | **Not implemented** |
| Assets | **Not implemented** |
| Audiences | **Not implemented** |
| Advanced reporting/segmentation | **Partially implemented** |
| Labels/shared sets | **Not implemented** |
| Advanced bid strategies | **Not implemented** |
| Experiments | **Not implemented** |
| Performance Max | **Not implemented** |
| Shopping | **Not implemented** |
| Keyword Planner | **Not implemented** |
| Account-scale automation | **Not implemented** |

## Implementation principles

1. **Capability over API mirroring.** Expose useful advertising operations, not Google's resource taxonomy verbatim.
2. **Read before write.** Mutations should be based on current account state.
3. **Validate before preview.** Invalid plans never reach the mutation stage.
4. **Explicit confirmation for mutations.** The MCP client must explicitly apply a previously previewed change.
5. **Revalidate immediately before apply.** A stale preview must not silently mutate a changed account.
6. **Atomic where possible.** Related Google Ads mutations should use grouped non-partial-failure operations when the API permits.
7. **Idempotency matters.** Retrying a workflow must not accidentally create duplicate campaigns, goals, ads, or other resources.
8. **Structured errors.** Google Ads API failures must preserve actionable error codes, messages, locations, and request IDs.
9. **Small coherent phases.** Each roadmap phase should be independently implementable, testable, and deployable.
10. **No speculative API surface.** Only expose a capability once its validation, mutation semantics, and failure behavior are understood.

## Tools

The server exposes read-only reporting plus controlled mutation workflows. Raw Google Ads mutation primitives are not exposed to the MCP client.

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
- Campaign bidding strategies
- Ad-group creation, status, and bidding
- Keyword creation, status, removal, and moves
- Campaign and ad-group negative keywords
- Ad status and removal
- Campaign conversion goals
- Custom conversion goals
- Responsive Search Ads
- Campaign restructuring
- Atomic restructure + RSA creation
- Campaign auditing

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
