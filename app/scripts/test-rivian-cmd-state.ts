// Diagnostic: query getVehicleCommand for a given command ID to see the
// state machine progression. Smoking-gun diagnostic when sendVehicleCommand
// returns success but the car doesn't physically respond.
//
// Run: cd app && npx tsx --env-file=.env.local scripts/test-rivian-cmd-state.ts <command-id>

import { getToken } from "@/lib/db";
import {
  RIVIAN_CLIENT_NAME,
  RIVIAN_GATEWAY_URL,
  RIVIAN_USER_AGENT,
} from "@/lib/rivian";

const QUERY = `query getVehicleCommand($id: String!) {
  getVehicleCommand(id: $id) {
    __typename id command createdAt state responseCode statusCode
  }
}`;

async function main() {
  const commandId = process.argv[2];
  if (!commandId) {
    console.error("Usage: tsx test-rivian-cmd-state.ts <command-id>");
    process.exit(1);
  }

  const tok = await getToken("rivian");
  if (!tok) throw new Error("no rivian token");
  const meta = (tok.meta as { csrf_token?: string; a_sess?: string }) ?? {};

  const res = await fetch(RIVIAN_GATEWAY_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "apollographql-client-name": RIVIAN_CLIENT_NAME,
      "user-agent": RIVIAN_USER_AGENT,
      "u-sess": tok.access_token,
      "a-sess": meta.a_sess ?? "",
      "csrf-token": meta.csrf_token ?? "",
    },
    body: JSON.stringify({
      operationName: "getVehicleCommand",
      query: QUERY,
      variables: { id: commandId },
    }),
  });

  console.log("HTTP", res.status);
  console.log(JSON.stringify(await res.json(), null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
