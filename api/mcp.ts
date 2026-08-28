import config from "../.generated/config.js";
import { createVercelHandler } from "../src/runtimes/vercel.js";

const handler = createVercelHandler({ config });

export function handleMcp(request: Request): Promise<Response> {
  return handler(request);
}

export default {
  async fetch(request: Request): Promise<Response> {
    return handleMcp(request);
  },
};
