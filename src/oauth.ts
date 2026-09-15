import { createHash, randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';

const issuer = process.env.OAUTH_ISSUER ?? 'https://cr8or-google-ads-production.up.railway.app';
const resource = `${issuer}/mcp`;
const usedCodes = new Set<string>();

function config() {
  const googleClientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const googleClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const signingSecret = process.env.OAUTH_SIGNING_SECRET;
  const allowedEmails = new Set((process.env.OAUTH_ALLOWED_EMAILS ?? '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean));
  if (!googleClientId || !googleClientSecret || !signingSecret || allowedEmails.size === 0) {
    throw new Error('OAuth is not configured. Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, OAUTH_SIGNING_SECRET, and OAUTH_ALLOWED_EMAILS.');
  }
  return { googleClientId, googleClientSecret, signingKey: new TextEncoder().encode(signingSecret), allowedEmails };
}

function hashPkce(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function isTrustedCimdHost(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'chatgpt.com' || url.hostname.endsWith('.chatgpt.com') || url.hostname === 'chat.openai.com');
  } catch {
    return false;
  }
}

async function getClientMetadata(clientId: string): Promise<{ redirectUris: string[]; clientName?: string }> {
  if (!isTrustedCimdHost(clientId)) throw new Error('Unsupported OAuth client_id');

  const response = await fetch(clientId, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Unable to fetch OAuth client metadata');
  const metadata = (await response.json()) as {
    client_id?: string;
    client_name?: string;
    redirect_uris?: unknown;
    response_types?: unknown;
    grant_types?: unknown;
    token_endpoint_auth_method?: unknown;
  };

  if (metadata.client_id !== clientId || !Array.isArray(metadata.redirect_uris) || metadata.redirect_uris.some((uri) => typeof uri !== 'string')) {
    throw new Error('Invalid OAuth client metadata');
  }
  const redirectUris = metadata.redirect_uris as string[];
  if (metadata.response_types && (!Array.isArray(metadata.response_types) || !metadata.response_types.includes('code'))) throw new Error('OAuth client does not support authorization code flow');
  if (metadata.grant_types && (!Array.isArray(metadata.grant_types) || !metadata.grant_types.includes('authorization_code'))) throw new Error('OAuth client does not support authorization code grant');
  return { redirectUris, clientName: typeof metadata.client_name === 'string' ? metadata.client_name : undefined };
}

async function signToken(subject: string, email: string, type: 'at+jwt' | 'rt+jwt'): Promise<string> {
  const { signingKey } = config();
  return new SignJWT({ email, scope: 'mcp' })
    .setProtectedHeader({ alg: 'HS256', typ: type })
    .setIssuer(issuer)
    .setAudience(resource)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime(type === 'at+jwt' ? '1h' : '30d')
    .sign(signingKey);
}

export async function verifyOAuthAccessToken(token: string): Promise<{ subject: string; email: string }> {
  const { signingKey } = config();
  const { payload, protectedHeader } = await jwtVerify(token, signingKey, {
    issuer,
    audience: resource,
    algorithms: ['HS256'],
  });
  if (protectedHeader.typ !== 'at+jwt' || typeof payload.sub !== 'string' || typeof payload.email !== 'string') throw new Error('Invalid OAuth access token');
  if (payload.scope !== 'mcp') throw new Error('Invalid OAuth scope');
  return { subject: payload.sub, email: payload.email };
}

export function oauthMetadata() {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp', 'offline_access'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

export function protectedResourceMetadata() {
  return {
    resource,
    authorization_servers: [issuer],
    scopes_supported: ['mcp'],
    bearer_methods_supported: ['header'],
  };
}

export async function handleOAuthAuthorize(url: URL): Promise<{ location: string }> {
  const { signingKey, googleClientId } = config();
  const redirectUri = url.searchParams.get('redirect_uri');
  const clientId = url.searchParams.get('client_id');
  const state = url.searchParams.get('state');
  const scope = url.searchParams.get('scope') ?? 'mcp';
  const challenge = url.searchParams.get('code_challenge');
  const resourceParam = url.searchParams.get('resource');

  if (!redirectUri || !clientId || url.searchParams.get('response_type') !== 'code' || !state || !challenge || url.searchParams.get('code_challenge_method') !== 'S256') {
    throw new Error('Invalid OAuth authorization request');
  }
  if (resourceParam !== resource) throw new Error('Invalid resource');
  if (scope.split(' ').some((v) => v !== 'mcp' && v !== 'offline_access')) throw new Error('Unsupported scope');

  const client = await getClientMetadata(clientId);
  if (!client.redirectUris.includes(redirectUri)) throw new Error('Unauthorized redirect_uri');

  const upstreamState = await new SignJWT({ clientId, redirectUri, state, scope, challenge, resource: resourceParam })
    .setProtectedHeader({ alg: 'HS256', typ: 'oauth-state' })
    .setIssuer(issuer)
    .setAudience('google-oauth-state')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(signingKey);

  const googleUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  googleUrl.searchParams.set('client_id', googleClientId);
  googleUrl.searchParams.set('redirect_uri', `${issuer}/oauth/callback`);
  googleUrl.searchParams.set('response_type', 'code');
  googleUrl.searchParams.set('scope', 'openid email profile');
  googleUrl.searchParams.set('state', upstreamState);
  googleUrl.searchParams.set('prompt', 'select_account');
  return { location: googleUrl.toString() };
}

export async function handleOAuthCallback(url: URL): Promise<{ location: string }> {
  const { signingKey, googleClientId, googleClientSecret, allowedEmails } = config();
  const error = url.searchParams.get('error');
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (error || !state || !code) throw new Error(`Google authorization failed: ${error ?? 'missing code or state'}`);

  const { payload } = await jwtVerify(state, signingKey, { issuer, audience: 'google-oauth-state', algorithms: ['HS256'] });
  const clientId = typeof payload.clientId === 'string' ? payload.clientId : '';
  const redirectUri = typeof payload.redirectUri === 'string' ? payload.redirectUri : '';
  const originalState = typeof payload.state === 'string' ? payload.state : '';
  const scope = typeof payload.scope === 'string' ? payload.scope : 'mcp';
  const challenge = typeof payload.challenge === 'string' ? payload.challenge : '';
  const stateResource = typeof payload.resource === 'string' ? payload.resource : '';
  if (!clientId || !redirectUri || !originalState || !challenge || stateResource !== resource) throw new Error('Invalid OAuth state');

  const client = await getClientMetadata(clientId);
  if (!client.redirectUris.includes(redirectUri)) throw new Error('Unauthorized redirect_uri');

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: googleClientId,
      client_secret: googleClientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: `${issuer}/oauth/callback`,
    }),
  });
  if (!tokenResponse.ok) throw new Error(`Google token exchange failed with HTTP ${tokenResponse.status}`);
  const googleTokens = (await tokenResponse.json()) as { access_token?: string };
  if (!googleTokens.access_token) throw new Error('Google token response did not contain an access token');

  const userResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${googleTokens.access_token}` } });
  if (!userResponse.ok) throw new Error(`Google userinfo request failed with HTTP ${userResponse.status}`);
  const user = (await userResponse.json()) as { sub?: string; email?: string; email_verified?: boolean };
  const email = user.email?.toLowerCase();
  if (!user.sub || !email || user.email_verified !== true || !allowedEmails.has(email)) throw new Error('Google account is not authorized to use this MCP server');

  const authorizationCode = await new SignJWT({ clientId, redirectUri, scope, subject: user.sub, email, challenge, resource })
    .setProtectedHeader({ alg: 'HS256', typ: 'oauth-code' })
    .setIssuer(issuer)
    .setAudience('oauth-token')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signingKey);
  const callback = new URL(redirectUri);
  callback.searchParams.set('code', authorizationCode);
  callback.searchParams.set('state', originalState);
  callback.searchParams.set('iss', issuer);
  return { location: callback.toString() };
}

export async function handleOAuthToken(request: Request): Promise<Response> {
  const body = await request.formData();
  const grantType = String(body.get('grant_type') ?? '');
  const clientId = String(body.get('client_id') ?? '');
  const resourceParam = String(body.get('resource') ?? '');

  if (!clientId || resourceParam !== resource) return oauthError('invalid_request');

  if (grantType === 'authorization_code') {
    const code = String(body.get('code') ?? '');
    const redirectUri = String(body.get('redirect_uri') ?? '');
    const verifier = String(body.get('code_verifier') ?? '');
    if (!code || !redirectUri || !verifier || usedCodes.has(code)) return oauthError('invalid_grant');
    try {
      const { signingKey } = config();
      const { payload } = await jwtVerify(code, signingKey, { issuer, audience: 'oauth-token', algorithms: ['HS256'] });
      if (payload.clientId !== clientId || payload.redirectUri !== redirectUri || payload.resource !== resource || typeof payload.subject !== 'string' || typeof payload.email !== 'string') return oauthError('invalid_grant');
      if (payload.challenge !== hashPkce(verifier)) return oauthError('invalid_grant');
      usedCodes.add(code);
      return jsonResponse({
        access_token: await signToken(payload.subject, payload.email, 'at+jwt'),
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: await signToken(payload.subject, payload.email, 'rt+jwt'),
        scope: 'mcp',
      });
    } catch {
      return oauthError('invalid_grant');
    }
  }

  if (grantType === 'refresh_token') {
    try {
      const { signingKey } = config();
      const refresh = String(body.get('refresh_token') ?? '');
      const { payload } = await jwtVerify(refresh, signingKey, { issuer, audience: resource, algorithms: ['HS256'] });
      if (typeof payload.sub !== 'string' || typeof payload.email !== 'string' || payload.scope !== 'mcp') throw new Error('invalid');
      return jsonResponse({
        access_token: await signToken(payload.sub, payload.email, 'at+jwt'),
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: await signToken(payload.sub, payload.email, 'rt+jwt'),
        scope: 'mcp',
      });
    } catch {
      return oauthError('invalid_grant');
    }
  }

  return oauthError('unsupported_grant_type');
}

function jsonResponse(body: object): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

function oauthError(error: string): Response {
  return new Response(JSON.stringify({ error }), { status: 400, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
