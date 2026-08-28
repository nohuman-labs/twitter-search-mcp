import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);

it("typechecks every repository script through the normal TypeScript project", async () => {
  const { stdout } = await execFileAsync("npx", [
    "tsc",
    "--noEmit",
    "--listFiles",
  ]);

  expect(stdout).toContain("scripts/doctor.ts");
  expect(stdout).toContain("scripts/generate-config.ts");
  expect(stdout).toContain("scripts/smoke-mcp.ts");
});
