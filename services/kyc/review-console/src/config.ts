// Build-time config, injected by build.mjs via esbuild `define`. No secrets: the Cognito app
// client is public (PKCE, no client secret).
export interface ConsoleConfig {
  apiUrl: string;
  cognitoDomain: string;
  clientId: string;
  redirectUri: string;
  logoutUri: string;
}

declare const __CONFIG__: ConsoleConfig;

export const config: ConsoleConfig = __CONFIG__;
