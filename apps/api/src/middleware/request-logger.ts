import { randomUUID } from "node:crypto";
import { pinoHttp } from "pino-http";
import { logger } from "../lib/logger.js";

// One log line per request. Headers, query strings and bodies are never logged,
// because they can contain cookies, tokens or personal data.
export const requestLogger = pinoHttp({
  logger,
  genReqId: (_req, res) => {
    const id = randomUUID();
    res.setHeader("X-Request-Id", id);
    return id;
  },
  autoLogging: { ignore: (req) => req.url === "/api/health" },
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  serializers: {
    req: (req) => ({
      id: req.id,
      method: req.method,
      path: String(req.url ?? "").split("?")[0],
    }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
});
