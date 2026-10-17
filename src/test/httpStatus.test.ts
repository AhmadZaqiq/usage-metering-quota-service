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
  });
});
