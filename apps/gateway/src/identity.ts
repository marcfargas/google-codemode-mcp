import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { AccessIdentity, AuthProps, GatewayEnv } from './types.ts';

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function canonicalOrigin(env: Pick<GatewayEnv, 'GATEWAY_ORIGIN'>): string {
  const url = new URL(env.GATEWAY_ORIGIN);
  if (url.protocol !== 'https:' || url.origin !== env.GATEWAY_ORIGIN)
    throw new Error('GATEWAY_ORIGIN must be a canonical HTTPS origin');
  return url.origin;
}

export function accessIssuer(env: Pick<GatewayEnv, 'CF_ACCESS_TEAM_DOMAIN'>): string {
  const value = env.CF_ACCESS_TEAM_DOMAIN;
  const url = new URL(value.startsWith('https://') ? value : `https://${value}`);
  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.cloudflareaccess.com') ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid Cloudflare Access team domain');
  return url.origin;
}

export function isAllowed(identity: AccessIdentity, env: GatewayEnv): boolean {
  return (
    identity.issuer === accessIssuer(env) &&
    typeof identity.subject === 'string' &&
    identity.subject.length > 0 &&
    typeof identity.email === 'string' &&
    env.ALLOWED_EMAILS.split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
      .includes(identity.email.toLowerCase())
  );
}

export async function verifyAccess(
  request: Request,
  env: GatewayEnv,
): Promise<AccessIdentity | null> {
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token || token.length > 16384) return null;
  const issuer = accessIssuer(env);
  if (!env.CF_ACCESS_AUD) throw new Error('Cloudflare Access audience is required');
  if (!keySets.has(issuer))
    keySets.set(issuer, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)));
  try {
    const { payload } = await jwtVerify(token, keySets.get(issuer)!, {
      issuer,
      audience: env.CF_ACCESS_AUD,
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'sub'],
    });
    if (
      payload.type !== 'app' ||
      typeof payload.iat !== 'number' ||
      payload.iat > Date.now() / 1000 + 60 ||
      payload.email_verified === false ||
      typeof payload.email !== 'string'
    )
      return null;
    const identity = { issuer, subject: payload.sub!, email: payload.email };
    return isAllowed(identity, env) ? identity : null;
  } catch {
    return null;
  }
}

export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function ownerFor(props: AuthProps, env: GatewayEnv): Promise<string> {
  if (!isAllowed(props.identity, env) || !props.google.subject || !env.ENVIRONMENT)
    throw new Error('Invalid artifact owner');
  return digest(
    JSON.stringify([
      'google-codemode-owner-v1',
      env.ENVIRONMENT,
      props.identity.issuer,
      props.identity.subject,
      props.google.subject,
    ]),
  );
}
