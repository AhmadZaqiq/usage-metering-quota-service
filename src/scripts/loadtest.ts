import { parseArgs } from "util";
// @ts-expect-error - autocannon doesn't have types but we use it as a dev dependency
import autocannon from "autocannon";

interface LoadTestArgs {
  url: string;
  duration: number;
  connections: number;
  pipelining: number;
  units: number;
  skipBootstrap: boolean;
  userId?: string;
}

interface AutocannonResult {
  requests: {
    mean: number;
    total: number;
    started: number;
    finished: number;
    sent: number;
  };
  latency: {
    p50: number;
    p90: number;
    p95: number;
    p99: number;
    max: number;
    mean: number;
    stddev: number;
    [key: string]: number;
  };
  throughput: {
    mean: number;
  };
  errors: number;
  timeouts: number;
  non2xx: number;
  mismatches: number;
  statusCodes?: Record<string, number>;
}

function parseCliArgs(): LoadTestArgs {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      url: { type: "string", short: "u", default: "http://localhost:3000" },
      duration: { type: "string", short: "d", default: "10" },
      connections: { type: "string", short: "c", default: "10" },
      pipelining: { type: "string", short: "p", default: "1" },
      units: { type: "string", short: "n", default: "1" },
      skipBootstrap: { type: "boolean", default: false },
      userId: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  return {
    url: values.url,
    duration: parseInt(values.duration, 10),
    connections: parseInt(values.connections, 10),
    pipelining: parseInt(values.pipelining, 10),
    units: parseInt(values.units, 10),
    skipBootstrap: values.skipBootstrap === true,
    userId: values.userId,
  };
}

function validateLocalUrl(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("URL must use http or https protocol");
    }
    const hostname = parsed.hostname;
    const isLocal = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    if (!isLocal) {
      throw new Error(
        `Refusing to run load test against non-local target: ${hostname}. ` +
        `Load tests must target localhost only. ` +
        `Use --url=http://localhost:3000 or set a local target explicitly.`
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("non-local target")) {
      throw e;
    }
    throw new Error(`Invalid URL: ${url}`);
  }
}

async function waitForServer(url: string, maxRetries = 30): Promise<void> {
  const healthUrl = new URL("/health/live", url).toString();
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Server at ${url} did not become ready in time`);
}

async function setupTestAccount(url: string, accountName: string, apiKeyName: string): Promise<string> {
  const bootstrapUrl = new URL("/api-keys", url).toString();
  
  // First, try to create account and API key via the API if endpoints exist
  // For now, we'll use a direct DB approach - but for load test we need the API key
  // We'll bootstrap via the script approach by calling the existing bootstrap logic
  // For load testing, we expect the bootstrap to have been run already
  
  // Try to get an API key by calling the API (this won't work without auth)
  // Instead, we'll rely on the bootstrap script having been run
  throw new Error(
    "Test account setup not implemented in load test. " +
    "Run 'npm run bootstrap' first with BOOTSTRAP_ACCOUNT_NAME and BOOTSTRAP_API_KEY_NAME set, " +
    "then use the generated API key."
  );
}

function createLoadTestConfig(
  args: LoadTestArgs,
  apiKey: string
): autocannon.Options {
  let requestCounter = 0;

  return {
    url: args.url,
    connections: args.connections,
    duration: args.duration,
    pipelining: args.pipelining,
    method: "POST",
    title: "Usage Metering Load Test",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    setupClient: (client: { on: (event: string, callback: (body: string) => void) => void }) => {
      client.on("body", (_body: string) => {
        // Track response for analysis if needed
      });
    },
    requests: [
      {
        method: "POST",
        path: "/usage",
        body: JSON.stringify({
          units: args.units.toString(),
          idempotencyKey: `loadtest-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
          userId: args.userId,
        }),
        setupRequest: (params: { body: string; headers: Record<string, string> }) => {
          // Generate unique idempotency key for each request
          const key = `loadtest-${Date.now()}-${++requestCounter}-${Math.random().toString(36).slice(2, 11)}`;
          const body = JSON.stringify({
            units: args.units.toString(),
            idempotencyKey: key,
            userId: args.userId,
          });
          return {
            ...params,
            body,
            headers: {
              ...params.headers,
              "Content-Length": Buffer.byteLength(body).toString(),
            },
          };
        },
      },
    ],
  };
}

function formatPercentile(value: number | undefined): string {
  if (value === undefined) return "N/A";
  return `${value.toFixed(2)} ms`;
}

function printResults(result: autocannon.Result, args: LoadTestArgs) {
  console.log("\n========== LOAD TEST RESULTS ==========");
  console.log(`Target URL: ${args.url}`);
  console.log(`Duration: ${args.duration}s`);
  console.log(`Connections: ${args.connections}`);
  console.log(`Pipelining: ${args.pipelining}`);
  console.log(`Units per request: ${args.units}`);
  console.log("--------------------------------------");

  // Throughput
  console.log("\n--- Throughput ---");
  console.log(`Requests/second: ${result.requests.mean.toFixed(2)} (mean)`);
  console.log(`  Total requests: ${result.requests.total}`);
  console.log(`  Started: ${result.requests.started}`);
  console.log(`  Finished: ${result.requests.finished}`);

  // Latency
  console.log("\n--- Latency (ms) ---");
  console.log(`  p50: ${formatPercentile(result.latency.p50)}`);
  console.log(`  p90: ${formatPercentile(result.latency.p90)}`);
  console.log(`  p95: ${formatPercentile(result.latency.p95)}`);
  console.log(`  p99: ${formatPercentile(result.latency.p99)}`);
  console.log(`  max: ${formatPercentile(result.latency.max)}`);
  console.log(`  mean: ${formatPercentile(result.latency.mean)}`);
  console.log(`  stddev: ${formatPercentile(result.latency.stddev)}`);

  // Throughput over time
  console.log("\n--- Throughput over time ---");
  console.log(`  Requests sent: ${result.requests.sent}`);
  console.log(`  Throughput: ${result.throughput.mean.toFixed(2)} MB/s`);

  // Errors
  console.log("\n--- Errors ---");
  console.log(`  Errors: ${result.errors}`);
  console.log(`  Timeouts: ${result.timeouts}`);
  console.log(`  Non-2xx: ${result.non2xx}`);
  console.log(`  Mismatches: ${result.mismatches}`);

  // Latency breakdown
  console.log("\n--- Latency Distribution ---");
  for (const [percentile, value] of Object.entries(result.latency)) {
    if (typeof value === "number" && percentile.startsWith("p")) {
      console.log(`  ${percentile}: ${formatPercentile(value)}`);
    }
  }

  // Status codes (from autocannon 7.x)
  if (result.statusCodes) {
    console.log("\n--- HTTP Status Codes ---");
    for (const [code, count] of Object.entries(result.statusCodes)) {
      console.log(`  ${code}: ${count}`);
    }
  }

  console.log("\n========================================\n");
}

async function main() {
  const args = parseCliArgs();

  // Safety check: only allow localhost targets
  validateLocalUrl(args.url);

  console.log("=== Usage Metering Load Test ===");
  console.log(`Target: ${args.url}`);
  console.log(`Duration: ${args.duration}s`);
  console.log(`Connections: ${args.connections}`);
  console.log(`Pipelining: ${args.pipelining}`);
  console.log("================================\n");

  // Wait for server to be ready
  console.log("Waiting for server to be ready...");
  await waitForServer(args.url);
  console.log("Server is ready.\n");

  // For now, we require the API key to be provided via environment
  // This is a safety measure to avoid accidental credential exposure
  const apiKey = process.env.LOADTEST_API_KEY;
  if (!apiKey) {
    console.error(
      "LOADTEST_API_KEY environment variable not set.\n" +
      "Run 'npm run bootstrap' first to create a test account and API key,\n" +
      "then set LOADTEST_API_KEY=your_generated_key before running the load test."
    );
    process.exit(1);
  }

  // Run load test
  const config = createLoadTestConfig(args, apiKey);
  console.log("Starting load test...\n");

  try {
    const result = await autocannon(config);
    printResults(result, args);

    // Exit with error code if there were significant errors
    if (result.errors > 0 || result.timeouts > 0) {
      console.warn("WARNING: Load test completed with errors/timeouts");
      process.exit(1);
    }
  } catch (error) {
    console.error("Load test failed:", error);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Load test error:", err);
  process.exit(1);
});