import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Config } from "./config.js";

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function authorized(config: Config, request: IncomingMessage): boolean {
  const header = request.headers.authorization ?? "";
  if (header.startsWith("Bearer ")) {
    return equal(header.slice("Bearer ".length), config.readToken);
  }
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return false;
    const user = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    return equal(user, config.user) && equal(password, config.password);
  }
  return false;
}
