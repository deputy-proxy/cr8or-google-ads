import { errors } from 'google-ads-api';
import { getCustomer } from './google-ads.js';

function json(data: unknown): string {
  return JSON.stringify(data, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2);
}

function escapeGaqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function errorPayload(error: unknown): string {
  if (error instanceof errors.GoogleAdsFailure) {
    return json({
      error: 'Google Ads API request failed',
      requestId: error.request_id,
      details: error.errors.map((item) => ({
        message: item.message,
        trigger: item.trigger,
        errorCode: item.error_code,
        location: item.location,
      })),
    });
  }
  return json({ error: error instanceof Error ? error.message : String(error) });
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

  const customer = getCustomer();
  const campaignWhere = campaignId
    ? `campaign.id = ${campaignId}`
    : `campaign.name = '${escapeGaqlString(campaignName as string)}'`;
  const dateFilter = fromDate
    ? `segments.date BETWEEN '${fromDate}' AND '${toDate}'`
    : 'segments.date DURING LAST_30_DAYS';

  const [campaignRows, adGroups, keywords, negativeKeywords, ads, locations, languages, schedules, campaignGoals, conversionActions, performance, searchTerms] = await Promise.all([
    customer.query(`
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
        campaign.start_date,
        campaign.end_date,
        campaign_budget.id,
        campaign_budget.name,
        campaign_budget.amount_micros,
        campaign_budget.status,
        campaign_budget.delivery_method
      FROM campaign
      WHERE ${campaignWhere}
    `),
    customer.query(`
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
    `),
    customer.query(`
      SELECT
        campaign.id,
        ad_group.id,
        ad_group.name,
        ad_group_criterion.criterion_id,
        ad_group_criterion.keyword.text,
        ad_group_criterion.keyword.match_type,
        ad_group_criterion.status,
        ad_group_criterion.quality_info.quality_score,
        ad_group_criterion.quality_info.creative_quality_score,
        ad_group_criterion.quality_info.landing_page_experience,
        ad_group_criterion.quality_info.post_click_quality_score,
        ad_group_criterion.quality_info.search_predicted_ctr
      FROM keyword_view
      WHERE ${campaignWhere}
        AND ad_group_criterion.status != 'REMOVED'
      ORDER BY ad_group.id, ad_group_criterion.criterion_id
    `),
    customer.query(`
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
    `),
    customer.query(`
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
    `),
    customer.query(`
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
    `),
    customer.query(`
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
    `),
    customer.query(`
      SELECT
        campaign.id,
        campaign_criterion.criterion_id,
        campaign_criterion.status,
        campaign_criterion.ad_schedule.day_of_week,
        campaign_criterion.ad_schedule.start_hour,
        campaign_criterion.ad_schedule.start_minute,
        campaign_criterion.ad_schedule.end_hour,
        campaign_criterion.ad_schedule.end_minute,
        campaign_criterion.ad_schedule.start_date,
        campaign_criterion.ad_schedule.end_date
      FROM campaign_criterion
      WHERE ${campaignWhere}
        AND campaign_criterion.type = AD_SCHEDULE
        AND campaign_criterion.status != 'REMOVED'
      ORDER BY campaign_criterion.criterion_id
    `),
    customer.query(`
      SELECT
        campaign_conversion_goal.campaign,
        campaign_conversion_goal.category,
        campaign_conversion_goal.origin,
        campaign_conversion_goal.biddable
      FROM campaign_conversion_goal
      WHERE ${campaignWhere}
    `),
    customer.query(`
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
    `),
    customer.query(`
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
        metrics.conversion_rate
      FROM campaign
      WHERE ${campaignWhere}
        AND ${dateFilter}
    `),
    customer.query(`
      SELECT
        campaign.id,
        ad_group.id,
        ad_group.name,
        search_term_view.search_term,
        search_term_view.status,
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
      FROM search_term_view
      WHERE ${campaignWhere}
        AND ${dateFilter}
      ORDER BY metrics.cost_micros DESC
      LIMIT 1000
    `),
  ]);

  const campaign = campaignRows[0];
  if (!campaign) {
    throw new Error(`Campaign not found: ${campaignId ?? campaignName}`);
  }

  return json({
    audit_scope: {
      campaign_id: campaign.id,
      campaign_name: campaign.name,
      date_range: fromDate ? { from: fromDate, to: toDate } : { relative: 'LAST_30_DAYS' },
    },
    campaign,
    ad_groups: adGroups,
    keywords,
    negative_keywords: negativeKeywords,
    ads,
    targeting: {
      locations,
      languages,
      schedules,
    },
    conversion_goals: campaignGoals,
    conversion_actions: conversionActions,
    performance,
    search_terms: searchTerms,
    audit_notes: {
      landing_pages: 'Landing-page relevance and conversion-path quality require inspecting the returned final_urls outside the Google Ads configuration data.',
      budget_assessment: 'Budget adequacy is contextual and should be assessed against bidding strategy, conversion volume, CPA targets and recent performance rather than budget alone.',
    },
  });
}

export function auditCampaignError(error: unknown): string {
  return errorPayload(error);
}
