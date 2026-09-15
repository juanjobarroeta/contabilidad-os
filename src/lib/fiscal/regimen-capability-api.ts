import { NextResponse } from "next/server";
import {
  isRegimenCalculationNotSupportedError,
  type RegimenCalculationNotSupportedError,
} from "./regimen-capabilities";

/** Convert only the stable fail-closed calculation error into an API response. */
export function regimenCalculationErrorResponse(
  error: RegimenCalculationNotSupportedError,
): NextResponse {
  return NextResponse.json(error.toPayload(), { status: error.status });
}

/** Reusable catch helper: unknown failures still propagate as server errors. */
export async function calculationForApi<T>(calculation: Promise<T>): Promise<T | NextResponse> {
  try {
    return await calculation;
  } catch (error) {
    if (isRegimenCalculationNotSupportedError(error)) {
      return regimenCalculationErrorResponse(error);
    }
    throw error;
  }
}
