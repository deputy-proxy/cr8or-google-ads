export interface GoogleAdsConfig {
  clientId: string;
  clientSecret: string;
  developerToken: string;
  refreshToken: string;
  customerId: string;
  loginCustomerId?: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function loadConfig(): GoogleAdsConfig {
  return {
    clientId: required('GOOGLE_ADS_CLIENT_ID'),
    clientSecret: required('GOOGLE_ADS_CLIENT_SECRET'),
    developerToken: required('GOOGLE_ADS_DEVELOPER_TOKEN'),
    refreshToken: required('GOOGLE_ADS_REFRESH_TOKEN'),
    customerId: required('GOOGLE_ADS_CUSTOMER_ID').replace(/-/g, ''),
    loginCustomerId: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.replace(/-/g, '') || undefined,
  };
}
