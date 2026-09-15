import { GoogleAdsApi, type Customer } from 'google-ads-api';
import { loadConfig } from './config.js';

const COMPATIBILITY_TOKEN = 'unused';

let cached: Customer | undefined;

function createClient(): GoogleAdsApi {
  const config = loadConfig();
  return new GoogleAdsApi({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    developer_token: COMPATIBILITY_TOKEN,
  });
}

export function getCustomer(): Customer {
  if (cached) return cached;

  const config = loadConfig();
  const client = createClient();

  cached = client.Customer({
    customer_id: config.customerId,
    login_customer_id: config.loginCustomerId,
    refresh_token: config.refreshToken,
  });

  return cached;
}

export async function listAccessibleCustomers(): Promise<string[]> {
  const config = loadConfig();
  const client = createClient();

  const response = await client.listAccessibleCustomers(config.refreshToken);
  return response.resource_names ?? [];
}
