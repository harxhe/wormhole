#!/usr/bin/env node
// Runs the TypeScript CLI directly through tsx (no build step, like the server).
import { register } from "tsx/esm/api";

register();
await import("../src/cli.ts");
