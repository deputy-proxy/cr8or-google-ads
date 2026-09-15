import { GoogleAdsApi, type Customer } from 'google-ads-api';
import { loadConfig } from './config.js';

let cached: Customer | undefined;

export function getCustomer(): Customer {
  if (cached) return cached;

  const config = loadConfig();
  const client = new GoogleAdsApi({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    developer_token: config.developerToken,
  });

  cached = client.Customer({
    customer_id: config.customerId,
    login_customer_id: config.loginCustomerId,
    refresh_token: config.refreshToken,
  });

  return cached;
}

export async function listAccessibleCustomers(): Promise<string[]> {
  const config = loadConfig();
  const client = new GoogleAdsApi({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    developer_token: config.developerToken,
  });

  const response = await client.listAccessibleCustomers(config.refreshToken);
  return response.resourceNames ?? [];
}
