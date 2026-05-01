// Public surface for the Rivian provider. Mirrors lib/smartcar's index
// so the consumers in lib/status, /api/integrations, and the route
// handlers can import a single canonical name.

export {
  loginFlow,
  createCsrfTokens,
  login,
  submitOtp,
  RIVIAN_GATEWAY_URL,
  RIVIAN_CLIENT_NAME,
  RIVIAN_USER_AGENT,
} from "./auth";
export {
  getCurrentUser,
  getEvSnapshot,
  isConfigured,
  listVehicles,
  pinVehicleId,
  setChargingSchedule,
  startCharging,
  stopCharging,
} from "./client";
export type {
  RivianCsrfTokens,
  RivianCurrentUser,
  RivianEvSnapshot,
  RivianLoginResponse,
  RivianLoginTokens,
  RivianUserVehicle,
  RivianVehicleState,
} from "./types";
