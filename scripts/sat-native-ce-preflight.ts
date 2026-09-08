/**
 * Credential-free SAT CE contract check. It sends no RFC, certificate,
 * private key, password, signed challenge, or customer data.
 */
import { runSatNativeCePublicPreflight } from "../src/lib/fiscal/cumplimiento/sat-native/preflight";
import {
  SatReadError,
  toSatReadFailure,
} from "../src/lib/fiscal/cumplimiento/sat-native/errors";

const OPERATION = "LIST_ELECTRONIC_ACCOUNTING" as const;

async function main(): Promise<void> {
  const result = await runSatNativeCePublicPreflight();
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
