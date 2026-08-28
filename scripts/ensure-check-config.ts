import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../src/config/load.js";

export async function ensureCheckConfig(
  configPath = "mcp.config.example.yaml",
  outputPath = ".generated/config.ts",
): Promise<void> {
  try {
    await readFile(outputPath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const config = await loadConfig(configPath);
  const source = `import type { AppConfig } from "../src/config/schema.js";\n\nconst config = ${JSON.stringify(config, null, 2)} satisfies AppConfig;\n\nexport default config;\n`;
  await mkdir(dirname(outputPath), { recursive: true });
  try {
    await writeFile(outputPath, source, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await ensureCheckConfig().catch(() => {
    console.error("Check configuration could not be prepared");
    process.exitCode = 1;
  });
}
