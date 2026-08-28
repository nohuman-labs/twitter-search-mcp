import { healthResponse } from "../src/core/http.js";
import { serverVersion } from "../src/core/server.js";

export default function healthz(_request: Request): Response {
  return healthResponse(serverVersion);
}
