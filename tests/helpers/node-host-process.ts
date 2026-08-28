import type { AddressInfo } from "node:net";
import type { AppConfig } from "../../src/config/schema.js";
import { createNodeServer } from "../../src/runtimes/node.js";

const config: AppConfig = {
  version: 1,
  access: { mode: "anonymous", token: "" },
  search: { default_provider: "twitee", allow_provider_override: true },
  providers: {
    twitee: { enabled: true, base_url: "https://twitee.test", token: "" },
    x: { enabled: false, base_url: "https://x.test", token: "" },
  },
  ratelimit: { enabled: false, limit: 60, window: "1m" },
};

const server = await createNodeServer({
  config,
  host: "127.0.0.1",
  port: 0,
});
const address = server.address() as AddressInfo;
process.stdout.write(`${address.port}\n`);

process.once("SIGTERM", () => {
  server.close(() => process.exit(0));
});
