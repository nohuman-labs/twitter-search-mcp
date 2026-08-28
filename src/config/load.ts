import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { type AppConfig, parseConfig } from "./schema.js";

export async function loadConfig(path: string): Promise<AppConfig> {
  return parseConfig(parseYaml(await readFile(path, "utf8")));
}
