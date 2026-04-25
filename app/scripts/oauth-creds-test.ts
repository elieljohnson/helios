// Decisive test: does our client_id + client_secret pair authenticate
// against /oauth/token at all? Use the simulator's known-good
// refresh_token (which we already saw works on the V2 vehicle API
// after injecting it). If THIS 401s, the creds in .env.local don't
// authenticate /oauth/token. If it 200s, /oauth/token works for us
// and the earlier authorization_code 401 was stale-code or
// redirect_uri-mismatch.
//
//   node --env-file=.env.local --import tsx scripts/oauth-creds-test.ts

const SIM_REFRESH = "54a6f554-3814-41a4-b462-bce5757c9234";

async function attempt(label: string, headers: Record<string, string>, body: URLSearchParams): Promise<void> {
  const res = await fetch("https://auth.smartcar.com/oauth/token", {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  const text = await res.text();
  const ok = res.status === 200 ? "✅" : "❌";
  console.log(`${ok} ${label} -> ${res.status}`);
  console.log(`   ${text.slice(0, 300)}\n`);
}

const CLIENT_ID = process.env.SMARTCAR_CLIENT_ID!;
const CLIENT_SECRET = process.env.SMARTCAR_CLIENT_SECRET!;
const APP_ID = process.env.SMARTCAR_APPLICATION_ID!;

const basic = (u: string, p: string) =>
  `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;

const refreshBody = () =>
  new URLSearchParams({ grant_type: "refresh_token", refresh_token: SIM_REFRESH });

(async () => {
  console.log(`CLIENT_ID=${CLIENT_ID}`);
  console.log(`CLIENT_SECRET=${CLIENT_SECRET.slice(0, 4)}...${CLIENT_SECRET.slice(-4)}`);
  console.log(`APP_ID=${APP_ID}\n`);

  // The canonical shape per Smartcar docs
  await attempt(
    "Basic(CLIENT_ID : CLIENT_SECRET)",
    { Authorization: basic(CLIENT_ID, CLIENT_SECRET) },
    refreshBody(),
  );

  // Try with the application UUID as username instead
  await attempt(
    "Basic(APP_ID : CLIENT_SECRET)",
    { Authorization: basic(APP_ID, CLIENT_SECRET) },
    refreshBody(),
  );

  // Body-param style (some servers accept both)
  await attempt(
    "Body(client_id=CLIENT_ID, client_secret=CLIENT_SECRET)",
    {},
    (() => {
      const b = refreshBody();
      b.set("client_id", CLIENT_ID);
      b.set("client_secret", CLIENT_SECRET);
      return b;
    })(),
  );

  // Body-param style with APP_ID
  await attempt(
    "Body(client_id=APP_ID, client_secret=CLIENT_SECRET)",
    {},
    (() => {
      const b = refreshBody();
      b.set("client_id", APP_ID);
      b.set("client_secret", CLIENT_SECRET);
      return b;
    })(),
  );
})();
