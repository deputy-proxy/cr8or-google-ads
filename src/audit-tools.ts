import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { auditCampaign, auditCampaignError } from './campaign-audit.js';

export function registerAuditTools(server: McpServer): void {
  server.registerTool(
    'campaign_audit',
    {
      title: 'Audit a Google Ads campaign',
      description: 'Return the detailed Google Ads configuration and recent performance data needed for a full campaign setup audit, including campaign settings, bidding, conversion goals/actions, targeting, schedule, ad groups, keywords, negative keywords, ads, landing URLs, performance and search terms.',
      inputSchema: z.object({
        campaignId: z.string().regex(/^\d+$/).optional().describe('Google Ads campaign ID.'),
        campaignName: z.string().min(1).optional().describe('Exact Google Ads campaign name.'),
        fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Start date, YYYY-MM-DD.'),
        toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('End date, YYYY-MM-DD.'),
      }).refine((value) => Boolean(value.campaignId || value.campaignName), {
        message: 'Provide campaignId or campaignName.',
      }).refine((value) => Boolean(value.fromDate) === Boolean(value.toDate), {
        message: 'fromDate and toDate must be provided together.',
      }),
    },
    async ({ campaignId, campaignName, fromDate, toDate }) => {
      try {
        return {
          content: [{
            type: 'text',
            text: await auditCampaign(campaignId, campaignName, fromDate, toDate),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: auditCampaignError(error) }],
          isError: true,
        };
      }
    },
  );
}
