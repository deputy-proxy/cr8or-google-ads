import { getCustomer, listAccessibleCustomers } from './google-ads.js';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const dateRange = {
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Start date, YYYY-MM-DD'),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('End date, YYYY-MM-DD'),
};

function json(data: unknown): string {
  return JSON.stringify(data, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2);
}

function queryWithDateRange(query: string, fromDate?: string, toDate?: string): string {
  if (!fromDate && !toDate) return `${query}\nAND segments.date DURING LAST_30_DAYS`;
  if (!fromDate || !toDate) throw new Error('fromDate and toDate must be provided together.');
  return `${query}\nAND segments.date BETWEEN '${fromDate}' AND '${toDate}'`;
}

export function registerReadTools(server: McpServer): void {
  server.registerTool(
    'list_accessible_customers',
    {
      title: 'List accessible Google Ads customers',
      description: 'List Google Ads customer accounts accessible with the configured OAuth credentials.',
      inputSchema: z.object({}),
    },
    async () => ({
      content: [{ type: 'text', text: json(await listAccessibleCustomers()) }],
    }),
  );

  server.registerTool(
    'get_account',
    {
      title: 'Get Google Ads account',
      description: 'Get the configured Google Ads account identity and basic account settings.',
      inputSchema: z.object({}),
    },
    async () => {
      const customer = getCustomer();
      const [account] = await customer.query(`
        SELECT
          customer.id,
          customer.descriptive_name,
          customer.currency_code,
          customer.time_zone,
          customer.manager,
          customer.test_account
        FROM customer
      `);
      return { content: [{ type: 'text', text: json(account) }] };
    },
  );

  server.registerTool(
    'list_campaigns',
    {
      title: 'List campaigns',
      description: 'List campaigns in the configured Google Ads account, including status, channel type and daily budget.',
      inputSchema: z.object({
        status: z.enum(['ENABLED', 'PAUSED', 'REMOVED', 'ALL']).default('ALL'),
        limit: z.number().int().min(1).max(1000).default(100),
      }),
    },
    async ({ status, limit }) => {
      const customer = getCustomer();
      const where = status === 'ALL' ? '' : `WHERE campaign.status = '${status}'`;
      const rows = await customer.query(`
        SELECT
          campaign.id,
          campaign.name,
          campaign.status,
          campaign.advertising_channel_type,
          campaign.bidding_strategy_type,
          campaign_budget.id,
          campaign_budget.name,
          campaign_budget.amount_micros,
          campaign_budget.status
        FROM campaign
        ${where}
        ORDER BY campaign.id
        LIMIT ${limit}
      `);
      return { content: [{ type: 'text', text: json(rows) }] };
    },
  );

  server.registerTool(
    'campaign_performance',
    {
      title: 'Get campaign performance',
      description: 'Return campaign performance metrics for the configured account. Defaults to the last 30 days when no dates are supplied.',
      inputSchema: z.object({
        ...dateRange,
        limit: z.number().int().min(1).max(1000).default(100),
      }),
    },
    async ({ fromDate, toDate, limit }) => {
      const customer = getCustomer();
      const base = `
        SELECT
          campaign.id,
          campaign.name,
          campaign.status,
          campaign.advertising_channel_type,
          campaign_budget.amount_micros,
          metrics.impressions,
          metrics.clicks,
          metrics.ctr,
          metrics.average_cpc,
          metrics.cost_micros,
          metrics.conversions,
          metrics.cost_per_conversion
        FROM campaign
        WHERE campaign.status != 'REMOVED'
      `;
      const query = queryWithDateRange(base, fromDate, toDate);
      const rows = await customer.query(`${query}\nORDER BY metrics.cost_micros DESC\nLIMIT ${limit}`);
      return { content: [{ type: 'text', text: json(rows) }] };
    },
  );

  server.registerTool(
    'ad_group_performance',
    {
      title: 'Get ad group performance',
      description: 'Return ad group performance metrics for the configured account. Defaults to the last 30 days when no dates are supplied.',
      inputSchema: z.object({
        ...dateRange,
        limit: z.number().int().min(1).max(1000).default(100),
      }),
    },
    async ({ fromDate, toDate, limit }) => {
      const customer = getCustomer();
      const base = `
        SELECT
          campaign.id,
          campaign.name,
          ad_group.id,
          ad_group.name,
          ad_group.status,
          metrics.impressions,
          metrics.clicks,
          metrics.ctr,
          metrics.average_cpc,
          metrics.cost_micros,
          metrics.conversions,
          metrics.cost_per_conversion
        FROM ad_group
        WHERE ad_group.status != 'REMOVED'
      `;
      const query = queryWithDateRange(base, fromDate, toDate);
      const rows = await customer.query(`${query}\nORDER BY metrics.cost_micros DESC\nLIMIT ${limit}`);
      return { content: [{ type: 'text', text: json(rows) }] };
    },
  );

  server.registerTool(
    'keyword_performance',
    {
      title: 'Get keyword performance',
      description: 'Return keyword performance, status and quality-related fields for the configured account. Defaults to the last 30 days when no dates are supplied.',
      inputSchema: z.object({
        ...dateRange,
        limit: z.number().int().min(1).max(2000).default(200),
      }),
    },
    async ({ fromDate, toDate, limit }) => {
      const customer = getCustomer();
      const base = `
        SELECT
          campaign.id,
          campaign.name,
          ad_group.id,
          ad_group.name,
          ad_group_criterion.criterion_id,
          ad_group_criterion.keyword.text,
          ad_group_criterion.keyword.match_type,
          ad_group_criterion.status,
          ad_group_criterion.quality_info.quality_score,
          metrics.impressions,
          metrics.clicks,
          metrics.ctr,
          metrics.average_cpc,
          metrics.cost_micros,
          metrics.conversions,
          metrics.cost_per_conversion
        FROM keyword_view
        WHERE ad_group_criterion.status != 'REMOVED'
      `;
      const query = queryWithDateRange(base, fromDate, toDate);
      const rows = await customer.query(`${query}\nORDER BY metrics.cost_micros DESC\nLIMIT ${limit}`);
      return { content: [{ type: 'text', text: json(rows) }] };
    },
  );

  server.registerTool(
    'search_terms',
    {
      title: 'Get search terms',
      description: 'Return actual search terms that triggered ads, with performance metrics. Defaults to the last 30 days when no dates are supplied.',
      inputSchema: z.object({
        ...dateRange,
        limit: z.number().int().min(1).max(2000).default(200),
      }),
    },
    async ({ fromDate, toDate, limit }) => {
      const customer = getCustomer();
      const base = `
        SELECT
          campaign.id,
          campaign.name,
          ad_group.id,
          ad_group.name,
          search_term_view.search_term,
          search_term_view.status,
          metrics.impressions,
          metrics.clicks,
          metrics.ctr,
          metrics.average_cpc,
          metrics.cost_micros,
          metrics.conversions,
          metrics.cost_per_conversion
        FROM search_term_view
      `;
      const query = queryWithDateRange(base, fromDate, toDate);
      const rows = await customer.query(`${query}\nORDER BY metrics.cost_micros DESC\nLIMIT ${limit}`);
      return { content: [{ type: 'text', text: json(rows) }] };
    },
  );
}
