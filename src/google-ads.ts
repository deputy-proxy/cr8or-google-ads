import { GoogleAdsApi, type Customer } from 'google-ads-api';
import { loadConfig } from './config.js';

const COMPATIBILITY_TOKEN = 'unused';

let cached: Customer | undefined;
const customerCache = new Map<string, Customer>();

function serializeGoogleAdsError(error: unknown): Record<string, unknown> {
  if (error === null || typeof error !== 'object') return { message: String(error) };

  const value = error as Record<string, unknown>;
  const serialized: Record<string, unknown> = {};
  const response = value.response && typeof value.response === 'object' ? value.response as Record<string, unknown> : undefined;

  const copy = (key: string, source: Record<string, unknown> = value) => {
    if (source[key] !== undefined) serialized[key] = source[key];
  };

  for (const key of [
    'name',
    'message',
    'code',
    'error_code',
    'requestId',
    'request_id',
    'errors',
    'error',
    'details',
    'partialFailureError',
    'partial_failure_error',
  ]) copy(key);

  if (response) {
    for (const key of ['name', 'message', 'code', 'requestId', 'request_id', 'errors', 'details']) {
      copy(key, response);
    }
  }

  if (!Object.keys(serialized).length) {
    try {
      serialized.details = JSON.parse(JSON.stringify(error, Object.getOwnPropertyNames(error)));
    } catch {
      serialized.details = Object.getOwnPropertyNames(error);
    }
  }

  return serialized;
}

function wrapCustomer(customer: Customer): Customer {
  return new Proxy(customer, {
    get(target, property, receiver) {
      if (property !== 'mutateResources') return Reflect.get(target, property, receiver);

      return async (...args: Parameters<Customer['mutateResources']>) => {
        try {
          return await target.mutateResources(...args);
        } catch (error) {
          throw new Error(`Google Ads mutation failed: ${JSON.stringify(serializeGoogleAdsError(error))}`, { cause: error });
        }
      };
    },
  });
}

function createClient(): GoogleAdsApi {
  const config = loadConfig();
  return new GoogleAdsApi({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    developer_token: COMPATIBILITY_TOKEN,
  });
}

export function getCustomerFor(customerId: string): Customer {
  const cachedCustomer = customerCache.get(customerId);
  if (cachedCustomer) return cachedCustomer;

  const config = loadConfig();
  const customer = wrapCustomer(createClient().Customer({
    customer_id: customerId,
    login_customer_id: config.loginCustomerId,
    refresh_token: config.refreshToken,
  }));

  customerCache.set(customerId, customer);
  return customer;
}

export function getCustomer(): Customer {
  if (cached) return cached;

  const config = loadConfig();
  cached = getCustomerFor(config.customerId);
  return cached;
}

export async function listAccessibleCustomers(): Promise<string[]> {
  const config = loadConfig();
  const client = createClient();

  const response = await client.listAccessibleCustomers(config.refreshToken);
  return response.resource_names ?? [];
}
