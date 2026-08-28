import { readyResponse } from "../src/core/http.js";
import { serverVersion } from "../src/core/server.js";

export default function readyz(_request: Request): Response {
  return readyResponse(serverVersion, true);
}
