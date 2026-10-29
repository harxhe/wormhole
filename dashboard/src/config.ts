/** Defaults for the local dashboard process. Environment variables win. */
export const DEFAULT_DASHBOARD_PORT = 4040;
export const DEFAULT_SERVER = process.env.WORMHOLE_SERVER ?? "localhost:4443";
export const DEFAULT_TOKEN = process.env.WORMHOLE_TOKEN ?? "dev-token-please-change";
export const DEFAULT_LOCAL_HOST = process.env.WORMHOLE_LOCAL_HOST ?? "localhost";
export const DEFAULT_PUBLIC_BASE = process.env.WORMHOLE_PUBLIC_BASE ?? "http://localhost:8080";
