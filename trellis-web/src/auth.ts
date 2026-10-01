import { UserManager, WebStorageStateStore } from 'oidc-client-ts';

/**
 * Настройка браузерного OIDC-клиента. Authorization Code + PKCE выполняется
 * в Keycloak, токен хранится в рамках вкладки и передаётся только API Knowledge.
 */
export const manager = new UserManager({
  authority: import.meta.env.VITE_OIDC_AUTHORITY ?? 'http://localhost:8080/realms/trellis',
  client_id: import.meta.env.VITE_OIDC_CLIENT_ID ?? 'trellis-web',
  redirect_uri: `${window.location.origin}/auth/callback`,
  post_logout_redirect_uri: `${window.location.origin}/auth/logout-callback`,
  response_type: 'code',
  scope: 'openid profile email',
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),
  automaticSilentRenew: true,
});
