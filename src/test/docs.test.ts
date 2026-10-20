import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { openApiSpec } from "../docs/openapi.js";

// Canonical operation list. If a route is added, removed, or renamed in
// src/app.ts + routers, this list and the spec must both change — the
// assertions below fail on any drift between routers and documentation.
const EXPECTED_OPERATIONS = [
  "get /health/live",
  "get /health/ready",
  "get /docs",
  "get /docs/openapi.json",
  "post /usage",
  "get /usage",
  "post /api-keys",
  "get /api-keys",
  "delete /api-keys/{id}",
  "post /plans",
  "get /plans",
  "get /plans/{id}",
  "patch /plans/{id}",
  "delete /plans/{id}",
  "post /assignments",
  "get /assignments",
  "get /assignments/current",
  "post /users",
  "get /users",
  "post /accounts",
  "get /usage/summary",
];

describe("OpenAPI documentation", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  it("serves the spec at /docs/openapi.json as OpenAPI 3.1", async () => {
    const res = await request(app).get("/docs/openapi.json");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.openapi).toBe("3.1.0");
    expect(res.body.info.title).toBe("Usage Metering & Quota Service");
  });

  it("documents every mounted operation", () => {
    const documented: string[] = [];
    for (const [path, item] of Object.entries(openApiSpec.paths)) {
      for (const method of Object.keys(item)) {
        documented.push(`${method} ${path}`);
      }
    }
    expect(documented.sort()).toEqual([...EXPECTED_OPERATIONS].sort());
  });

  it("declares bearer API-key security on the spec and exempts public endpoints", () => {
    expect(openApiSpec.security).toEqual([{ apiKey: [] }]);
    expect(openApiSpec.components.securitySchemes.apiKey.scheme).toBe("bearer");
    // Public endpoints override the global security requirement.
    expect(openApiSpec.paths["/health/live"].get.security).toEqual([]);
    expect(openApiSpec.paths["/health/ready"].get.security).toEqual([]);
    expect(openApiSpec.paths["/docs"].get.security).toEqual([]);
    expect(openApiSpec.paths["/docs/openapi.json"].get.security).toEqual([]);
  });

  it("serves the Swagger UI at /docs/ (redirecting /docs)", async () => {
    const redirect = await request(app).get("/docs");
    expect(redirect.status).toBe(301);
    expect(redirect.headers.location).toBe("/docs/");

    const res = await request(app).get("/docs/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toContain("swagger-ui");
  });

  it("serves the Swagger UI assets under /docs", async () => {
    const res = await request(app).get("/docs/swagger-ui.css");
    expect(res.status).toBe(200);
  });
});
