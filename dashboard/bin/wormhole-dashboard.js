#!/usr/bin/env node
// Runs the dashboard CLI directly through tsx (no build step).
import { register } from "tsx/esm/api";

register();
await import("../src/cli.ts");
