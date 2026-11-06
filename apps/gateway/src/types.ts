import type { OAuthHelpers, OAuthResourceContext } from '@cloudflare/workers-oauth-provider';

export interface AccessIdentity {
  issuer: string;
  subject: string;
  email: string;
}

export interface AuthProps {
  identity: AccessIdentity;
  google: {
    subject: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  };
}

export interface GatewayEnv {
  GATEWAY_ORIGIN: string;
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  ALLOWED_EMAILS: string;
  ENVIRONMENT: string;
  GOOGLE_OAUTH_CLIENT_ID: string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER?: OAuthHelpers;
}

export type AuthContext = OAuthResourceContext<AuthProps>;
