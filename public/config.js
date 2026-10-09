// BigBooks Forecast & Scenarios configuration.
//
// This app targets BigBooks staging. To use another environment, change API
// and ISSUER together: a 401 from the API names its authorization server at
// {API}/.well-known/oauth-protected-resource.
//
// CLIENT_ID is a PUBLIC OAuth client (token endpoint auth method "none", PKCE / S256)
// registered at {ISSUER}/clients with this app's URL as a redirect URI.
// No client secret goes here — this file ships to the browser.

const ISSUER = 'https://staging.bigbooks.app';   // the authorization server whose tokens the API accepts

export const CONFIG = {
  CLIENT_ID: '',                           // <-- your public client_id

  API: 'https://staging.bigbooks.app/api',
  ISSUER,
  AUTHORIZE_URL: `${ISSUER}/oauth2/authorize`,
  TOKEN_URL: `${ISSUER}/oauth2/token`,
  USERINFO_URL: `${ISSUER}/oauth2/userInfo`,
  SCOPES: 'openid profile email',
  REDIRECT_URI: window.location.origin + window.location.pathname,

  // Local development only: show a "use an access token" form on the sign-in card,
  // for when no OAuth client is registered against the local issuer.
  ALLOW_PASTED_TOKEN: true,
};
