import { errors } from 'google-ads-api';
import { getCustomer } from './google-ads.js';

const LIMITS = {
  adGroups: 200,
  keywords: 200,
  negativeKeywords: 200,
  ads: 200,
  locations: 100,
  languages: 100,
  schedules: 100,
  campaignGoals: 100,
  conversionActions: 100,
  searchTerms: 100,
};

type QueryResult = {
  items: unknown[];
  truncated: boolean;
};

function json(data: unknown): string {
  return JSON.stringify(data, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2);
}

function escapeGaqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof errors.GoogleAdsFailure) {
    return {
      message: 'Google Ads API request failed',
      requestId: error.request_id,
      details: error.errors.map((item) => ({
        message: item.message,
        trigger: item.trigger,
        errorCode: item.error_code,
        location: item.location,
      })),
    };
  }

  return {
    message: error instanceof Error ? error.message : String(error),
  };
}

function errorPayload(error: unknown): string {
  return json({ error: errorDetails(error) });
}

async function querySection(
  name: string,
  query: string,
  limit?: number,
): Promise<{ name: string; result?: QueryResult; error?: Record<string, unknown> }> {
  try {
    const rows = await getCustomer().query(query);
    const items = limit === undefined ? rows : rows.slice(0, limit);

    return {
      name,
      result: {
        items,
        truncated: limit !== undefined && rows.length > limit,
      },
    };
  } catch (error) {
    console.error(`[campaign_audit] ${name} failed`, errorDetails(error));
    return { name, error: errorDetails(error) };
  }
}

export async function auditCampaign(
  campaignId?: string,
  campaignName?: string,
  fromDate?: string,
  toDate?: string,
): Promise<string> {
  if (!campaignId && !campaignName) {
    throw new Error('Provide campaignId or campaignName.');
  }
  if ((fromDate && !toDate) || (!fromDate && toDate)) {
    throw new Error('fromDate and toDate must be provided together.');
  }

  const campaignWhere = campaignId
    ? `campaign.id = ${campaignId}`
    : `campaign.name = '${escapeGaqlString(campaignName as string)}'`;
  const dateFilter = fromDate
    ? `segments.date BETWEEN '${fromDate}' AND '${toDate}'`
    : 'segments.date DURING LAST_30_DAYS';
  const customer = getCustomer();

  const campaignRows = await customer.query(`
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      campaign.advertising_channel_sub_type,
      campaign.bidding_strategy_type,
      campaign.bidding_strategy,
      campaign.target_cpa.target_cpa_micros,
      campaign.target_roas.target_roas,
      campaign.maximize_conversions.target_cpa_micros,
      campaign.maximize_conversion_value.target_roas,
      campaign.network_settings.target_google_search,
      campaign.network_settings.target_search_network,
      campaign.network_settings.target_content_network,
      campaign.network_settings.target_partner_search_network,
      campaign.start_date_time,
      campaign.end_date_time,
      campaign_budget.id,
      campaign_budget.name,
      campaign_budget.amount_micros,
      campaign_budget.status,
      campaign_budget.delivery_method
    FROM campaign
    WHERE ${campaignWhere}
  `);

  const campaignRow = campaignRows[0];
  const campaign = campaignRow?.campaign;
  if (!campaign) {
    throw new Error(`Campaign not found: ${campaignId ?? campaignName}`);
  }

  const sections = [
    await querySection('ad_groups', `
      SELECT
        campaign.id,
        ad_group.id,
        ad_group.name,
        ad_group.status,
        ad_group.type,
        ad_group.cpc_bid_micros,
        ad_group.target_cpa_micros,
        ad_group.target_roas
      FROM ad_group
      WHERE ${campaignWhere}
        AND ad_group.status != 'REMOVED'
      ORDER BY ad_group.id
      LIMIT ${LIMITS.adGroups + 1}
    `, LIMITS.adGroups),
    await querySection('keywords', `
      SELECT
        campaign.id,
        ad_group.id,
        ad_group.name,
        ad_group_criterion.criterion_id,
        ad_group_criterion.keyword.text,
        ad_group_criterion.keyword.match_type,
        ad_group_criterion.status,
        metrics.historical_quality_score,
        metrics.historical_creative_quality_score,
        metrics.historical_landing_page_quality_score,
        metrics.historical_search_predicted_ctr
      FROM keyword_view
      WHERE ${campaignWhere}
        AND ad_group_criterion.status != 'REMOVED'
      ORDER BY ad_group.id, ad_group_criterion.criterion_id
      LIMIT ${LIMITS.keywords + 1}
    `, LIMITS.keywords),
    await querySection('negative_keywords', `
      SELECT
        campaign.id,
        campaign_criterion.criterion_id,
        campaign_criterion.negative,
        campaign_criterion.keyword.text,
        campaign_criterion.keyword.match_type,
        campaign_criterion.status
      FROM campaign_criterion
      WHERE ${campaignWhere}
        AND campaign_criterion.negative = TRUE
        AND campaign_criterion.type = KEYWORD
        AND campaign_criterion.status != 'REMOVED'
      ORDER BY campaign_criterion.criterion_id
      LIMIT ${LIMITS.negativeKeywords + 1}
    `, LIMITS.negativeKeywords),
    await querySection('ads', `
      SELECT
        campaign.id,
        ad_group.id,
        ad_group.name,
        ad_group_ad.ad.id,
        ad_group_ad.status,
        ad_group_ad.ad.type,
        ad_group_ad.ad.name,
        ad_group_ad.ad.final_urls,
        ad_group_ad.ad.tracking_url_template,
        ad_group_ad.ad.responsive_search_ad.headlines,
        ad_group_ad.ad.responsive_search_ad.descriptions,
        ad_group_ad.ad.responsive_search_ad.path1,
        ad_group_ad.ad.responsive_search_ad.path2
      FROM ad_group_ad
      WHERE ${campaignWhere}
        AND ad_group_ad.status != 'REMOVED'
      ORDER BY ad_group.id, ad_group_ad.ad.id
      LIMIT ${LIMITS.ads + 1}
    `, LIMITS.ads),
    await querySection('locations', `
      SELECT
        campaign.id,
        campaign_criterion.criterion_id,
        campaign_criterion.negative,
        campaign_criterion.status,
        campaign_criterion.location.geo_target_constant
      FROM campaign_criterion
      WHERE ${campaignWhere}
        AND campaign_criterion.type = LOCATION
        AND campaign_criterion.status != 'REMOVED'
      ORDER BY campaign_criterion.criterion_id
      LIMIT ${LIMITS.locations + 1}
    `, LIMITS.locations),
    await querySection('languages', `
      SELECT
        campaign.id,
        campaign_criterion.criterion_id,
        campaign_criterion.negative,
        campaign_criterion.status,
        campaign_criterion.language.language_constant
      FROM campaign_criterion
      WHERE ${campaignWhere}
        AND campaign_criterion.type = LANGUAGE
        AND campaign_criterion.status != 'REMOVED'
      ORDER BY campaign_criterion.criterion_id
      LIMIT ${LIMITS.languages + 1}
    `, LIMITS.languages),
    await querySection('schedules', `
      SELECT
        campaign.id,
        campaign_criterion.criterion_id,
        campaign_criterion.status,
        campaign_criterion.ad_schedule.day_of_week,
        campaign_criterion.ad_schedule.start_hour,
        campaign_criterion.ad_schedule.start_minute,
        campaign_criterion.ad_schedule.end_hour,
        campaign_criterion.ad_schedule.end_minute
      FROM campaign_criterion
      WHERE ${campaignWhere}
        AND campaign_criterion.type = AD_SCHEDULE
        AND campaign_criterion.status != 'REMOVED'
      ORDER BY campaign_criterion.criterion_id
      LIMIT ${LIMITS.schedules + 1}
    `, LIMITS.schedules),
    await querySection('conversion_goals', `
      SELECT
        campaign_conversion_goal.campaign,
        campaign_conversion_goal.category,
        campaign_conversion_goal.origin,
        campaign_conversion_goal.biddable
      FROM campaign_conversion_goal
      WHERE ${campaignWhere}
      LIMIT ${LIMITS.campaignGoals + 1}
    `, LIMITS.campaignGoals),
    await querySection('conversion_actions', `
      SELECT
        conversion_action.resource_name,
        conversion_action.id,
        conversion_action.name,
        conversion_action.status,
        conversion_action.type,
        conversion_action.category,
        conversion_action.primary_for_goal,
        conversion_action.include_in_conversions_metric
      FROM conversion_action
      WHERE conversion_action.status != 'REMOVED'
      ORDER BY conversion_action.id
      LIMIT ${LIMITS.conversionActions + 1}
    `, LIMITS.conversionActions),
    await querySection('performance', `
      SELECT
        campaign.id,
        campaign.name,
        metrics.impressions,
        metrics.clicks,
        metrics.ctr,
        metrics.average_cpc,
        metrics.cost_micros,
        metrics.conversions,
        metrics.cost_per_conversion,
        metrics.conversions_value,
        metrics.conversions_from_interactions_rate
      FROM campaign
      WHERE ${campaignWhere}
        AND ${dateFilter}
    `),
    await querySection('search_terms', `
      SELECT
        campaign.id,
        ad_group.id,
        ad_group.name,
        campaign_search_term_view.search_term,
        segments.keyword.info.text,
        segments.keyword.info.match_type,
        segments.search_term_match_type,
        segments.search_term_targeting_status,
        metrics.impressions,
        metrics.clicks,
        metrics.ctr,
        metrics.average_cpc,
        metrics.cost_micros,
        metrics.conversions,
        metrics.cost_per_conversion
      FROM campaign_search_term_view
      WHERE ${campaignWhere}
        AND ${dateFilter}
      ORDER BY metrics.cost_micros DESC
      LIMIT ${LIMITS.searchTerms + 1}
    `, LIMITS.searchTerms),
  ];

  const byName = new Map(sections.map((section) => [section.name, section]));
  const sectionData = (name: string) => byName.get(name)?.result ?? { items: [], truncated: false };
  const sectionError = (name: string) => byName.get(name)?.error;

  return json({
    audit_scope: {
      campaign_id: campaign.id,
      campaign_name: campaign.name,
      date_range: fromDate ? { from: fromDate, to: toDate } : { relative: 'LAST_30_DAYS' },
    },
    campaign: {
      ...campaign,
      budget: campaignRow.campaign_budget,
    },
    sections: {
      ad_groups: sectionData('ad_groups'),
      keywords: sectionData('keywords'),
      negative_keywords: sectionData('negative_keywords'),
      ads: sectionData('ads'),
      targeting: {
        locations: sectionData('locations'),
        languages: sectionData('languages'),
        schedules: sectionData('schedules'),
      },
      conversion_goals: sectionData('conversion_goals'),
      conversion_actions: sectionData('conversion_actions'),
      performance: sectionData('performance'),
      search_terms: sectionData('search_terms'),
    },
    section_errors: Object.fromEntries(
      sections
        .filter((section) => section.error)
        .map((section) => [section.name, sectionError(section.name)]),
    ),
    audit_notes: {
      response_limits: 'Large collections are intentionally capped to keep the MCP response bounded. A truncated section means additional rows exist in Google Ads but are not included in this response.',
      landing_pages: 'Landing-page relevance and conversion-path quality require inspecting the returned final_urls outside the Google Ads configuration data.',
      budget_assessment: 'Budget adequacy is contextual and should be assessed against bidding strategy, conversion volume, CPA targets and recent performance rather than budget alone.',
    },
  });
}

export function auditCampaignError(error: unknown): string {
  return errorPayload(error);
}
