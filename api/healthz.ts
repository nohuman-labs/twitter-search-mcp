import { healthResponse } from "../src/core/http.js";
import { serverVersion } from "../src/core/server.js";

export function handleHealthz(_request: Request): Response {
  return healthResponse(serverVersion);
}

export default {
  async fetch(request: Request): Promise<Response> {
    return handleHealthz(request);
  },
};
