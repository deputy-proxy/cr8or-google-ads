import { createHash, randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';

const issuer = process.env.OAUTH_ISSUER ?? 'https://cr8or-google-ads-production.up.railway.app';
const resource = `${issuer}/mcp`;
const googleClientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const signingSecret = process.env.OAUTH_SIGNING_SECRET;
const allowedEmails = new Set(
  (process.env.OAUTH_ALLOWED_EMAILS ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
);
const allowedRedirectUris = new Set(
  (process.env.OAUTH_ALLOWED_REDIRECT_URIS ?? '')
    .split(',')
    .map((uri) => uri.trim())
    .filter(Boolean),
);

if (!googleClientId || !googleClientSecret || !signingSecret) {
  throw new Error(
    'Missing OAuth configuration: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and OAUTH_SIGNING_SECRET are required.',
  );
}

if (allowedEmails.size === 0) {
  throw new Error('OAUTH_ALLOWED_EMAILS must contain at least one allowed Google account email.');
}

if (allowedRedirectUris.size === 0) {
  throw new Error('OAUTH_ALLOWED_REDIRECT_URIS must contain at least one exact ChatGPT OAuth callback URL.');
}

const signingKey = new TextEncoder().encode(signingSecret);
const usedCodes = new Set<string>();

function base64UrlSha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function assertRedirectUri(uri: string): void {
  if (!allowedRedirectUris.has(uri)) {
    throw new Error('Unauthorized redirect_uri');
  }
}

async function signAccessToken(subject: string, email: string): Promise<string> {
  return new SignJWT({ email, scope: 'mcp' })
    .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
    .setIssuer(issuer)
    .setAudience(resource)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(signingKey);
}

async function signRefreshToken(subject: string, email: string): Promise<string> {
  return new SignJWT({ email, scope: 'mcp' })
    .setProtectedHeader({ alg: 'HS256', typ: 'rt+jwt' })
    .setIssuer(issuer)
    .setAudience(resource)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(signingKey);
}

export async function verifyOAuthAccessToken(token: string): Promise<{ subject: string; email: string }> {
  const { payload, protectedHeader } = await jwtVerify(token, signingKey, {
    issuer,
    audience: resource,
    algorithms: ['HS256'],
  });

  if (protectedHeader.typ !== 'at+jwt' || typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
    throw new Error('Invalid OAuth access token');
  }

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
    scopes_supported: ['mcp'],
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
  const redirectUri = url.searchParams.get('redirect_uri');
  const clientId = url.searchParams.get('client_id');
  const responseType = url.searchParams.get('response_type');
  const state = url.searchParams.get('state');
  const scope = url.searchParams.get('scope') ?? 'mcp';
  const codeChallenge = url.searchParams.get('code_challenge');
  const codeChallengeMethod = url.searchParams.get('code_challenge_method');

  if (!redirectUri || !clientId || responseType !== 'code' || !state) {
    throw new Error('Invalid OAuth authorization request');
  }

  assertRedirectUri(redirectUri);
  if (scope.split(' ').some((item) => item !== 'mcp')) {
    throw new Error('Unsupported scope');
  }
  if (codeChallenge && codeChallengeMethod !== 'S256') {
    throw new Error('Only S256 PKCE is supported');
  }

  const googleState = await new SignJWT({
    clientId,
    redirectUri,
    state,
    scope,
    codeChallenge: codeChallenge ?? undefined,
  })
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
  googleUrl.searchParams.set('access_type', 'online');
  googleUrl.searchParams.set('prompt', 'select_account');
  googleUrl.searchParams.set('state', googleState);

  return { location: googleUrl.toString() };
}

export async function handleOAuthCallback(url: URL): Promise<{ location: string }> {
  const error = url.searchParams.get('error');
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');

  if (error || !state || !code) {
    throw new Error(`Google authorization failed: ${error ?? 'missing code or state'}`);
  }

  const { payload } = await jwtVerify(state, signingKey, {
    issuer,
    audience: 'google-oauth-state',
    algorithms: ['HS256'],
  });

  const clientId = typeof payload.clientId === 'string' ? payload.clientId : undefined;
  const redirectUri = typeof payload.redirectUri === 'string' ? payload.redirectUri : undefined;
  const originalState = typeof payload.state === 'string' ? payload.state : undefined;
  const scope = typeof payload.scope === 'string' ? payload.scope : 'mcp';
  const codeChallenge = typeof payload.codeChallenge === 'string' ? payload.codeChallenge : undefined;

  if (!clientId || !redirectUri || !originalState) {
    throw new Error('Invalid OAuth state');
  }

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

  if (!tokenResponse.ok) {
    throw new Error(`Google token exchange failed with HTTP ${tokenResponse.status}`);
  }

  const googleTokens = (await tokenResponse.json()) as { access_token?: string };
  if (!googleTokens.access_token) {
    throw new Error('Google token response did not contain an access token');
  }

  const userInfoResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${googleTokens.access_token}` },
  });

  if (!userInfoResponse.ok) {
    throw new Error(`Google userinfo request failed with HTTP ${userInfoResponse.status}`);
  }

  const user = (await userInfoResponse.json()) as { sub?: string; email?: string; email_verified?: boolean };
  const email = user.email?.toLowerCase();
  if (!user.sub || !email || user.email_verified !== true || !allowedEmails.has(email)) {
    throw new Error('Google account is not authorized to use this MCP server');
  }

  const authorizationCode = await new SignJWT({
    clientId,
    redirectUri,
    scope,
    subject: user.sub,
    email,
    codeChallenge,
    nonce: randomUUID(),
  })
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

  if (grantType === 'authorization_code') {
    const code = String(body.get('code') ?? '');
    const redirectUri = String(body.get('redirect_uri') ?? '');
    const codeVerifier = String(body.get('code_verifier') ?? '');

    if (!code || !clientId || !redirectUri || !codeVerifier || usedCodes.has(code)) {
      return oauthError('invalid_grant', 'Invalid authorization code');
    }

    try {
      const { payload } = await jwtVerify(code, signingKey, {
        issuer,
        audience: 'oauth-token',
        algorithms: ['HS256'],
      });

      if (
        payload.clientId !== clientId ||
        payload.redirectUri !== redirectUri ||
        typeof payload.subject !== 'string' ||
        typeof payload.email !== 'string'
      ) {
        return oauthError('invalid_grant', 'Authorization code does not match the client');
      }

      if (payload.codeChallenge && payload.codeChallenge !== base64UrlSha256(codeVerifier)) {
        return oauthError('invalid_grant', 'PKCE verification failed');
      }

      usedCodes.add(code);
      const accessToken = await signAccessToken(payload.subject, payload.email);
      const refreshToken = await signRefreshToken(payload.subject, payload.email);

      return jsonResponse({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: refreshToken,
        scope: 'mcp',
      });
    } catch {
      return oauthError('invalid_grant', 'Invalid authorization code');
    }
  }

  if (grantType === 'refresh_token') {
    const refreshToken = String(body.get('refresh_token') ?? '');
    try {
      const { payload } = await jwtVerify(refreshToken, signingKey, {
        issuer,
        audience: resource,
        algorithms: ['HS256'],
      });
      if (payload.sub === undefined || typeof payload.email !== 'string') {
        throw new Error('Invalid refresh token');
      }
      const accessToken = await signAccessToken(String(payload.sub), payload.email);
      const newRefreshToken = await signRefreshToken(String(payload.sub), payload.email);
      return jsonResponse({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: newRefreshToken,
        scope: 'mcp',
      });
    } catch {
      return oauthError('invalid_grant', 'Invalid refresh token');
    }
  }

  return oauthError('unsupported_grant_type', 'Unsupported grant type');
}

function jsonResponse(body: object): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}

function oauthError(error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status: 400,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
