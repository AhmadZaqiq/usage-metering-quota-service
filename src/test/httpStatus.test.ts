import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { errorHandler } from "../errors/errorHandler.js";

describe("HTTP status and error handling", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
  });

  describe("GET /health/live", () => {
    it("returns 200 OK", async () => {
      const res = await request(app).get("/health/live");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "ok" });
    });
  });

  describe("GET /health/ready", () => {
    it("returns 200 OK with database healthy", async () => {
      const res = await request(app).get("/health/ready");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.checks.database.healthy).toBe(true);
    });
  });

  describe("undefined routes", () => {
    it("returns 404 with the standard JSON error shape", async () => {
      const res = await request(app).get("/undefined-route");
      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        error: {
          code: "NOT_FOUND",
          message: "Resource not found",
          details: undefined,
        },
      });
    });

    it("returns 404 for GET /ready (no route registered)", async () => {
      const res = await request(app).get("/ready");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });

    it("returns 404 for GET /health (no route registered)", async () => {
      const res = await request(app).get("/health");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });
  });

  describe("error middleware order", () => {
    it("places the 404 catch-all before the error handler, so unknown routes are 404 not 500", async () => {
      const res = await request(app).get("/does-not-exist");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });
  });

  describe("genuine unexpected errors", () => {
    it("errorHandler maps a plain Error to 500 without exposing internals", async () => {
      let capturedStatus: number | null = null;
      let capturedBody: unknown = null;
      const mockReq = {} as never;
      const mockRes = {
        getHeader: () => "unknown",
        status: (code: number) => {
          capturedStatus = code;
          return mockRes;
        },
        json: (body: unknown) => {
          capturedBody = body;
          return mockRes;
        },
      } as never;

      errorHandler(
        new Error("something unexpected broke"),
        mockReq,
        mockRes,
        () => {},
      );

      expect(capturedStatus).toBe(500);
      expect((capturedBody as { error: { code: string; message: string } }).error.code).toBe("INTERNAL_ERROR");
      expect((capturedBody as { error: { message: string } }).error.message).toBe("Internal server error");
      expect((capturedBody as { error: { details: unknown } }).error.details).toBeUndefined();
    });

    it.each([
      ["40001", "could not serialize access due to concurrent update"],
      ["40P01", "deadlock detected"],
    ])(
      "errorHandler maps PostgreSQL SQLSTATE %s to 503 TRANSACTION_CONFLICT",
      async (sqlState, message) => {
        let capturedStatus: number | null = null;
        let capturedBody: unknown = null;
        const mockReq = {} as never;
        const mockRes = {
          getHeader: () => "unknown",
          status: (code: number) => {
            capturedStatus = code;
            return mockRes;
          },
          json: (body: unknown) => {
            capturedBody = body;
            return mockRes;
          },
        } as never;

        errorHandler(
          Object.assign(new Error(message), { code: sqlState }),
          mockReq,
          mockRes,
          () => {},
        );

        expect(capturedStatus).toBe(503);
        expect((capturedBody as { error: { code: string; message: string } }).error.code).toBe("TRANSACTION_CONFLICT");
        expect((capturedBody as { error: { message: string } }).error.message).toBe("Transaction conflict, please retry");
      },
    );
  });

  describe("database pool acquisition timeout", () => {
    interface Captured {
      status: number | null;
      body: unknown;
      headers: Record<string, string>;
    }

    function callErrorHandler(err: Error): Captured {
      const captured: Captured = { status: null, body: undefined, headers: {} };
      const mockReq = {} as never;
      const mockRes = {
        getHeader: () => "unknown",
        setHeader: (name: string, value: string) => {
          captured.headers[name] = value;
          return mockRes;
        },
        status: (code: number) => {
          captured.status = code;
          return mockRes;
        },
        json: (body: unknown) => {
          captured.body = body;
          return mockRes;
        },
      } as never;

      errorHandler(err, mockReq, mockRes, () => {});
      return captured;
    }

    it("maps the exact pg-pool acquire timeout (no SQLSTATE) to 503 DATABASE_CAPACITY_EXCEEDED with Retry-After: 1", () => {
      const captured = callErrorHandler(new Error("timeout exceeded when trying to connect"));

      expect(captured.status).toBe(503);
      const error = (captured.body as { error: { code: string; message: string; details?: unknown } }).error;
      expect(error.code).toBe("DATABASE_CAPACITY_EXCEEDED");
      expect(error.message).toBe("Database is temporarily at capacity, please retry");
      expect(error.details).toBeUndefined();
      expect(captured.headers["Retry-After"]).toBe("1");
    });

    it("still maps an unrelated generic error to 500 with no Retry-After", () => {
      const captured = callErrorHandler(new Error("something unexpected broke"));

      expect(captured.status).toBe(500);
      const error = (captured.body as { error: { code: string } }).error;
      expect(error.code).toBe("INTERNAL_ERROR");
      expect(captured.headers["Retry-After"]).toBeUndefined();
    });

    it("does not classify a near-miss message as pool exhaustion", () => {
      const captured = callErrorHandler(new Error("timeout exceeded when trying to connect to primary"));

      expect(captured.status).toBe(500);
      expect((captured.body as { error: { code: string } }).error.code).toBe("INTERNAL_ERROR");
      expect(captured.headers["Retry-After"]).toBeUndefined();
    });

    it("prefers the SQLSTATE branch when the pool-timeout message carries a code", () => {
      const captured = callErrorHandler(
        Object.assign(new Error("timeout exceeded when trying to connect"), { code: "40001" }),
      );

      expect(captured.status).toBe(503);
      expect((captured.body as { error: { code: string } }).error.code).toBe("TRANSACTION_CONFLICT");
      expect(captured.headers["Retry-After"]).toBeUndefined();
    });
  });
});
