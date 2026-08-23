// Produces the deployable zip — the artifact `aws lambda create-function`
// takes. It is a script rather than a CI-only shell line so the same command
// makes the same artifact on a laptop and on a runner, and so the zip's
// contents are decided in one reviewed place: forwarder.mjs and its
// package.json, nothing else. There are no dependencies to bundle, which is the
// point of the artifact being dependency-free.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "dist");
const zipPath = join(outDir, "cloudwatch-forwarder.zip");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// -j flattens: the handler must sit at the zip root for AWS to resolve
// `forwarder.handler`.
execFileSync("zip", ["-j", "-q", zipPath, join(here, "forwarder.mjs"), join(here, "package.json")], {
  stdio: "inherit",
});

console.log(zipPath);
