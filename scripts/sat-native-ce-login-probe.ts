/**
 * One-shot, read-only SAT CE e.firma probe for an explicitly authorized RFC.
 * It sends one signed login POST and never follows the resulting redirect.
 * All target, operator, run, acknowledgement, and scope gates come from the
 * worker environment. Output is the redacted SatReadResult only.
 */
import { runSatNativeCeFirstSignedPostProbe } from "../src/lib/fiscal/cumplimiento/sat-native/ce-login-probe";
import {
  SatReadError,
  toSatReadFailure,
} from "../src/lib/fiscal/cumplimiento/sat-native/errors";
import { prisma } from "../src/lib/prisma";

const OPERATION = "LIST_ELECTRONIC_ACCOUNTING" as const;

async function main(): Promise<void> {
  let result: Awaited<ReturnType<typeof runSatNativeCeFirstSignedPostProbe>>;
  try {
    result = await runSatNativeCeFirstSignedPostProbe();
  } finally {
    await prisma.$disconnect();
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

void main().catch(() => {
  const failure = toSatReadFailure(
    new SatReadError("UNEXPECTED", OPERATION),
    OPERATION,
  );
  process.stdout.write(`${JSON.stringify(failure)}\n`);
  process.exitCode = 1;
});
