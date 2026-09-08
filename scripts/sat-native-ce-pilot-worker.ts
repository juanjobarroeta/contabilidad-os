/**
 * Railway one-shot entrypoint for the supervised CE evidence pilot.
 *
 * Default is inert. PUBLIC_PREFLIGHT sends no customer data. The signed mode
 * still has to pass every independent broker, database, route, and TLS gate.
 */
import {
  SatReadError,
  toSatReadFailure,
} from "../src/lib/fiscal/cumplimiento/sat-native/errors";
import { runSatNativeCePublicPreflight } from "../src/lib/fiscal/cumplimiento/sat-native/preflight";
import { parseSatNativePilotWorkerAction } from "../src/lib/fiscal/cumplimiento/sat-native/worker-action";

const OPERATION = "LIST_ELECTRONIC_ACCOUNTING" as const;
const ACTION = parseSatNativePilotWorkerAction(
  process.env.SAT_NATIVE_PILOT_ACTION,
);

function writeFailure(code: "NOT_CONFIGURED" | "UNEXPECTED"): void {
  const failure = toSatReadFailure(new SatReadError(code, OPERATION), OPERATION);
  process.stdout.write(`${JSON.stringify(failure)}\n`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  if (ACTION === "DISABLED") {
    process.stdout.write(`${JSON.stringify({
      state: "DISABLED",
      credentialUsed: false,
      authenticated: false,
    })}\n`);
    return;
  }

  if (ACTION === "PUBLIC_PREFLIGHT") {
    const result = await runSatNativeCePublicPreflight();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (ACTION === "INVALID") {
    writeFailure("NOT_CONFIGURED");
    return;
  }

  // Keep the database client and credential broker out of the module graph for
  // DISABLED and PUBLIC_PREFLIGHT. They are loaded only after the exact signed
  // action selector passes.
  const [probeModule, prismaModule] = await Promise.all([
    import("../src/lib/fiscal/cumplimiento/sat-native/ce-login-probe"),
    import("../src/lib/prisma"),
  ]);
  let result: Awaited<
    ReturnType<typeof probeModule.runSatNativeCeFirstSignedPostProbe>
  >;
  try {
    result = await probeModule.runSatNativeCeFirstSignedPostProbe();
  } finally {
    await prismaModule.prisma.$disconnect();
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

void main().catch(() => {
  writeFailure("UNEXPECTED");
});
