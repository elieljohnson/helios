// Minimal type shim for the `smartcar` npm package — the published JS
// has no .d.ts. We only declare the surface we actually call from
// `lib/smartcar/`. If we start using more of the SDK, extend here.

declare module "smartcar" {
  export interface SmartcarTokens {
    accessToken: string;
    refreshToken: string;
    expiration: Date;
    refreshExpiration: Date;
  }

  export interface AuthClientOptions {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    mode?: "live" | "test" | "simulated";
    testMode?: boolean;
  }

  export interface AuthUrlOptions {
    state?: string;
    forcePrompt?: boolean;
    makeBypass?: string;
    singleSelect?: boolean | { vin?: string };
    flags?: string[];
  }

  export class AuthClient {
    constructor(options: AuthClientOptions);
    getAuthUrl(scope: string[], options?: AuthUrlOptions): string;
    exchangeCode(code: string): Promise<SmartcarTokens>;
    exchangeRefreshToken(refreshToken: string): Promise<SmartcarTokens>;
  }

  export interface VehicleResponse<T> {
    meta?: Record<string, unknown>;
  }

  export interface BatteryResponse extends VehicleResponse<unknown> {
    range: number;
    percentRemaining: number;
  }

  export interface ChargeResponse extends VehicleResponse<unknown> {
    isPluggedIn: boolean;
    state: string;
  }

  export interface VehicleInfoResponse extends VehicleResponse<unknown> {
    id: string;
    make: string;
    model: string;
    year: number;
  }

  export interface ActionResponse extends VehicleResponse<unknown> {
    status: string;
    message?: string;
  }

  export class Vehicle {
    constructor(id: string, accessToken: string, options?: { unitSystem?: "metric" | "imperial" });
    battery(): Promise<BatteryResponse>;
    charge(): Promise<ChargeResponse>;
    info(): Promise<VehicleInfoResponse>;
    startCharge(): Promise<ActionResponse>;
    stopCharge(): Promise<ActionResponse>;
  }

  export function getVehicles(
    accessToken: string,
    paging?: { limit?: number; offset?: number },
  ): Promise<{ vehicles: string[]; paging: { count: number; offset: number } }>;

  const _default: {
    AuthClient: typeof AuthClient;
    Vehicle: typeof Vehicle;
    getVehicles: typeof getVehicles;
  };
  export default _default;
}
