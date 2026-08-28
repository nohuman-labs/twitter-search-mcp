import { readyResponse } from "../src/core/http.js";
import { serverVersion } from "../src/core/server.js";

export function handleReadyz(_request: Request): Response {
  return readyResponse(serverVersion, true);
}

export default {
  async fetch(request: Request): Promise<Response> {
    return handleReadyz(request);
  },
};
