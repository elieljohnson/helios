// AMT (Application Management Token) probe — figure out what cred shape
// the Smartcar /oauth/token endpoint wants.
//
// We've confirmed:
//   - Client ID + Client Secret pair authenticates against the *M2M*
//     endpoint (iam.smartcar.com/oauth2/token) — works.
//   - Same pair against auth.smartcar.com/oauth/token returns
//     401 invalid_client. Dashboard now confirms that pair is "M2M auth
//     flow" only.
//   - Simulator gave us a known-good refresh_token, so we can test
//     refresh_token grants without needing a fresh authorization_code.
//
// This script tries the AMT in four credential positions against
// /oauth/token with grant_type=refresh_token. Whichever returns 200
// with new tokens is the one to wire into auth.ts.
//
//   node --env-file=.env.local --import tsx scripts/amt-probe.ts <AMT>

const OAUTH_TOKEN_URL = "https://auth.smartcar.com/oauth/token";
const SIM_REFRESH_TOKEN = "54a6f554-3814-41a4-b462-bce5757c9234";

const amt = process.argv[2];
if (!amt) {
  console.error("usage: amt-probe.ts <application-management-token>");
  process.exit(1);
}

const APP_ID = process.env.SMARTCAR_APPLICATION_ID!;
const CLIENT_ID = process.env.SMARTCAR_CLIENT_ID!;

type Attempt = {
  name: string;
  headers: Record<string, string>;
  body: URLSearchParams;
};

function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

const baseBody = (): URLSearchParams =>
  new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: SIM_REFRESH_TOKEN,
  });

const attempts: Attempt[] = [
  {
    name: "1. Basic(client_01... : AMT)",
    headers: { Authorization: basic(CLIENT_ID, amt) },
    body: baseBody(),
  },
  {
    name: "2. Basic(application UUID : AMT)",
    headers: { Authorization: basic(APP_ID, amt) },
    body: baseBody(),
  },
  {
    name: "3. Bearer AMT",
    headers: { Authorization: `Bearer ${amt}` },
    body: baseBody(),
  },
  {
    name: "4. Body params (client_id=client_01..., client_secret=AMT)",
    headers: {},
    body: (() => {
      const b = baseBody();
      b.set("client_id", CLIENT_ID);
      b.set("client_secret", amt);
      return b;
    })(),
  },
  {
    name: "5. Body params (client_id=APP_UUID, client_secret=AMT)",
    headers: {},
    body: (() => {
      const b = baseBody();
      b.set("client_id", APP_ID);
      b.set("client_secret", amt);
      return b;
    })(),
  },
];

async function run(a: Attempt): Promise<void> {
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      ...a.headers,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: a.body.toString(),
  });
  const text = await res.text();
  const ok = res.status === 200 ? "✅" : "❌";
  console.log(`${ok} ${a.name} -> ${res.status}`);
  console.log(`   ${text.slice(0, 300)}`);
}

async function probeConnections(): Promise<void> {
  // Bonus: confirm AMT works as a Bearer on the V3 admin API.
  const res = await fetch("https://api.smartcar.com/v3/connections", {
    headers: { Authorization: `Bearer ${amt}`, Accept: "application/json" },
  });
  const text = await res.text();
  const ok = res.status === 200 ? "✅" : "❌";
  console.log(`\n[bonus] ${ok} GET /v3/connections (Bearer AMT) -> ${res.status}`);
  console.log(`   ${text.slice(0, 300)}`);
}

(async () => {
  console.log(`APP_ID=${APP_ID}`);
  console.log(`CLIENT_ID=${CLIENT_ID}`);
  console.log(`AMT=${amt.slice(0, 8)}...${amt.slice(-4)}\n`);
  for (const a of attempts) {
    try {
      await run(a);
    } catch (err) {
      console.log(`💥 ${a.name} -> ${(err as Error).message}`);
    }
  }
  try {
    await probeConnections();
  } catch (err) {
    console.log(`💥 connections probe -> ${(err as Error).message}`);
  }
})();
