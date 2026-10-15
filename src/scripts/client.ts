import { parseArgs } from "util";

interface ClientArgs {
  url: string;
  key: string;
  units: string;
  userId?: string;
  idempotencyKey: string;
}

function parseCliArgs(): ClientArgs {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      url: { type: "string", short: "u", default: "http://localhost:3000" },
      key: { type: "string", short: "k" },
      units: { type: "string", short: "n" },
      userId: { type: "string" },
      idempotencyKey: { type: "string", short: "i" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (!values.key || !values.units || !values.idempotencyKey) {
    console.error("Usage: npm run client -- -k <api-key> -n <units> -i <idempotency-key> [--userId <id>] [-u <url>]");
    process.exit(1);
  }

  return {
    url: values.url,
    key: values.key,
    units: values.units,
    userId: values.userId,
    idempotencyKey: values.idempotencyKey,
  };
}

async function makeRequest(args: ClientArgs) {
  const body: Record<string, unknown> = {
    units: args.units,
    idempotencyKey: args.idempotencyKey,
  };
  if (args.userId) body.userId = args.userId;

  const response = await fetch(`${args.url}/usage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.key}`,
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  console.log(`Status: ${response.status}`);
  console.log(JSON.stringify(data, null, 2));

  return { status: response.status, data };
}

async function main() {
  const args = parseCliArgs();

  console.log(`\n=== Usage Request ===`);
  console.log(`POST ${args.url}/usage`);
  console.log(`Authorization: Bearer ${args.key.slice(0, 20)}...`);
  console.log(`Body: ${JSON.stringify({ units: args.units, userId: args.userId, idempotencyKey: args.idempotencyKey })}`);
  console.log("========================\n");

  await makeRequest(args);
}

main().catch((err) => {
  console.error("Client error:", err);
  process.exit(1);
});