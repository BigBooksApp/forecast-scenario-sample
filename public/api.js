import { CONFIG } from './config.js';

// ------------------------------------------------------------------- PKCE
const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function randomString(len = 64) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'[b % 64]).join('');
}
const s256 = async (v) => b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)));

// ---------------------------------------------------------------- session
const TOKEN_KEY = 'bbf_token';
export const getToken = () => {
  try {
    const t = JSON.parse(sessionStorage.getItem(TOKEN_KEY));
    return t && t.access_token && Date.now() < t.expiresAt ? t : null;
  } catch { return null; }
};
export const setToken = (json, party = null) =>
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify({
    access_token: json.access_token,
    id_token: json.id_token || null,
    party,
    expiresAt: Date.now() + ((Number(json.expires_in) || 300) - 30) * 1000,
  }));
export const clearToken = () => sessionStorage.removeItem(TOKEN_KEY);

export async function beginLogin() {
  const verifier = randomString();
  const state = randomString(24);
  sessionStorage.setItem('pkce_verifier', verifier);
  sessionStorage.setItem('pkce_state', state);
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: CONFIG.CLIENT_ID,
    redirect_uri: CONFIG.REDIRECT_URI,
    scope: CONFIG.SCOPES,
    state,
    code_challenge: await s256(verifier),
    code_challenge_method: 'S256',
  });
  window.location.assign(`${CONFIG.AUTHORIZE_URL}?${p}`);
}

// Returns true if an OAuth redirect was consumed.
export async function completeRedirect() {
  const q = new URLSearchParams(window.location.search);
  const cleanUrl = () => history.replaceState({}, '', CONFIG.REDIRECT_URI);
  if (q.has('error')) {
    cleanUrl();
    throw new Error(`Authorization failed: ${q.get('error')} ${q.get('error_description') || ''}`);
  }
  if (!q.has('code')) return false;
  const verifier = sessionStorage.getItem('pkce_verifier');
  if (!verifier || q.get('state') !== sessionStorage.getItem('pkce_state')) {
    cleanUrl();
    throw new Error('OAuth state mismatch — please sign in again.');
  }
  const res = await fetch(CONFIG.TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: q.get('code'),
      redirect_uri: CONFIG.REDIRECT_URI,
      client_id: CONFIG.CLIENT_ID,
      code_verifier: verifier,
    }),
  });
  const text = await res.text();
  cleanUrl();
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}). ${text.slice(0, 300)}`);
  setToken(JSON.parse(text));
  sessionStorage.removeItem('pkce_verifier');
  sessionStorage.removeItem('pkce_state');
  return true;
}

function decodeJwt(jwt) {
  try {
    const p = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(p))));
  } catch { return null; }
}
const partyClaim = (c) => (c && typeof c['bigbooks:party'] === 'string' ? c['bigbooks:party'] : null);

// Integrator guide: access tokens carry no party claim; the id_token or
// GET {issuer}/oauth2/userInfo does (`bigbooks:party`).
export async function resolveParty() {
  const t = getToken();
  if (t.party) return t.party;
  const fromToken = partyClaim(decodeJwt(t.id_token || '')) || partyClaim(decodeJwt(t.access_token));
  if (fromToken) return fromToken;
  const res = await fetch(CONFIG.USERINFO_URL, { headers: { Authorization: `Bearer ${t.access_token}` } });
  if (!res.ok) throw new Error(`userInfo failed (${res.status})`);
  const party = partyClaim(await res.json());
  if (!party) throw new Error('No bigbooks:party claim in the token or userInfo — is the openid scope granted?');
  return party;
}

// ----------------------------------------------------------- API requests
export class AuthExpired extends Error {}
export class ApiError extends Error {
  constructor(status, code, messages, path) {
    super(`${status}${code ? ` ${code}` : ''} from ${path}: ${messages.join('; ') || '(no body)'}`);
    Object.assign(this, { status, code, messages, path });
  }
}

// One request. `query` values that are arrays repeat the parameter (the spec's
// `scenario=…&scenario=…`). `party` adds X-Acting-Party-ID; `ifMatch` the
// entity version for versioned mutations. Resolves to { data, etag }.
export async function http(method, path, { query, body, party, ifMatch } = {}) {
  const token = getToken();
  if (!token) throw new AuthExpired('Not signed in');
  const url = new URL(CONFIG.API + path);
  for (const [k, v] of Object.entries(query || {})) {
    for (const item of [].concat(v)) {
      if (item !== undefined && item !== null && item !== '') url.searchParams.append(k, item);
    }
  }
  const headers = { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' };
  if (party) headers['X-Acting-Party-ID'] = party;
  if (ifMatch != null) headers['If-Match'] = `"${ifMatch}"`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    throw new Error(`Network error calling ${method} ${path} — is the API at ${CONFIG.API} running and allowing this origin? (${e.message})`);
  }
  if (res.status === 401) { clearToken(); throw new AuthExpired('Session expired'); }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const errs = Array.isArray(data?.errors) ? data.errors : [typeof data === 'string' ? data.slice(0, 200) : ''];
    throw new ApiError(res.status, data?.code || null, errs.filter(Boolean), `${method} ${path}`);
  }
  const etag = res.headers.get('ETag');
  return { data, etag: etag ? etag.replace(/^W\//, '').replace(/"/g, '') : null };
}
