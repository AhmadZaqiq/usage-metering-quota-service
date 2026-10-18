import { describe, it, expect } from "vitest";
import pino from "pino";
import { PassThrough } from "node:stream";
import { buildLoggerOptions, REDACT_PATHS, logger } from "../logging/logger.js";

// The app logger must build with the exported options (invalid redact paths
// would throw at import time), and those options must actually censor
// credential-bearing fields wherever they appear in a log object.
describe("Logger credential redaction", () => {
  async function captureLog(obj: Record<string, unknown>): Promise<Record<string, unknown>> {
    const stream = new PassThrough();
    // Test env sets LOG_LEVEL=warn; force info so the capture cannot hang.
    const testLogger = pino({ ...buildLoggerOptions(), level: "info" }, stream);

    const line = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      stream.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const newline = buffer.indexOf("\n");
        if (newline >= 0) resolve(buffer.slice(0, newline));
      });
      stream.on("error", reject);
      testLogger.info(obj, "event");
    });

    return JSON.parse(line) as Record<string, unknown>;
  }

  it("builds the shared app logger with the redaction configuration", () => {
    expect(logger).toBeDefined();
    expect(REDACT_PATHS).toContain("req.headers.authorization");
    expect(REDACT_PATHS).toContain("headers['x-api-key']");
  });

  it("censors a top-level authorization field", async () => {
    const line = await captureLog({ authorization: "Bearer super-secret-token" });
    expect(JSON.stringify(line)).not.toContain("super-secret-token");
    expect(JSON.stringify(line)).toContain("[REDACTED]");
  });

  it("censors req.headers.authorization", async () => {
    const line = await captureLog({
      req: { headers: { authorization: "Bearer super-secret-token" } },
    });
    expect(JSON.stringify(line)).not.toContain("super-secret-token");
  });

  it("censors the x-api-key header", async () => {
    const line = await captureLog({
      headers: { "x-api-key": "ak-live-super-secret" },
    });
    expect(JSON.stringify(line)).not.toContain("ak-live-super-secret");
  });

  it("keeps ordinary fields intact", async () => {
    const line = await captureLog({ method: "POST", path: "/usage", statusCode: 200 });
    expect(line.method).toBe("POST");
    expect(line.path).toBe("/usage");
    expect(line.statusCode).toBe(200);
  });
});
