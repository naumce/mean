import { google } from "googleapis";

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};

// Sheets only — no Drive scope at all (final fix wave, C1). The dispatcher
// pastes the sheet's link; `spreadsheets` opens any sheet the account can
// read, and `spreadsheets.get` answers the title and tabs.
export const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
];

export function oauthClient() {
  return new google.auth.OAuth2(env("GOOGLE_CLIENT_ID"), env("GOOGLE_CLIENT_SECRET"), env("GOOGLE_REDIRECT_URI"));
}

/** `state` is opaque to Google — it is the org's signed nonce minted by
 *  Task 7, round-tripped through the OAuth redirect. */
export function consentUrl(state: string): string {
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state,
    include_granted_scopes: true,
  });
}

export async function exchangeCode(code: string): Promise<{ refreshToken: string; accountEmail: string | null }> {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error("Google did not return a refresh token — revoke the app at myaccount.google.com/permissions and connect again");
  }
  client.setCredentials(tokens);
  const info = await google.oauth2({ version: "v2", auth: client }).userinfo.get().catch(() => null);
  return { refreshToken: tokens.refresh_token, accountEmail: info?.data.email ?? null };
}

export function clientFor(refreshToken: string) {
  const c = oauthClient();
  c.setCredentials({ refresh_token: refreshToken });
  return c;
}
