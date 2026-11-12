/**
 * Import this first in unit tests: points settings, telemetry and worker sandboxes at a
 * throwaway directory before `src/config.ts` is evaluated, so tests never read a local
 * settings.json or touch ~/.gemini.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy2api-unit-"));
process.env.AGY2API_HOME = home;
process.env.AGY_GEMINI_HOME = path.join(home, "gemini");

process.on("exit", () => {
  fs.rmSync(home, { recursive: true, force: true });
});

export const unitTestHome = home;
