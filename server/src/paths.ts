import { fileURLToPath } from "node:url";

/** Absolute path to the `server/` directory. */
export const SERVER_ROOT = fileURLToPath(new URL("../", import.meta.url));

/** Default configuration file location. */
export const DEFAULT_CONFIG_PATH = fileURLToPath(new URL("../config.yaml", import.meta.url));
