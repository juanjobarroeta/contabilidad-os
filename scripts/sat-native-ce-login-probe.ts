/**
 * One-shot, read-only SAT CE e.firma probe for an explicitly authorized RFC.
 * It sends one signed login POST and never follows the resulting redirect.
 * All target, operator, run, acknowledgement, and scope gates come from the
 * worker environment. Output is the redacted SatReadResult only.
 */
import { runSatNativeCeFirstSignedPostProbe } from "../src/lib/fiscal/cumplimiento/sat-native/ce-login-probe";

async function main(): Promise<void> {
  const result = await runSatNativeCeFirstSignedPostProbe();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

void main();
