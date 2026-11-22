// Refuse a test process before loading tests when its dependencies are stale.
import { resolve } from "node:path";
import { enforceModules } from "./modules-guard.ts";

if (!enforceModules(resolve(import.meta.dir, ".."))) process.exit(1);
