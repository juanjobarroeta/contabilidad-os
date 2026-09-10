# INPC provenance — August 2026

## Seed

| Period | Value | Official publication | Publication date |
|---|---:|---|---|
| 2026-08 | 145.462 | [INEGI Bulletin of Indicator 586/26](https://www.inegi.org.mx/contenidos/saladeprensa/boletines/2026/inpc/inpc_2q2026_09.pdf) | 2026-09-09 |

INEGI reports a monthly change of 0.20% and an annual change of 3.26%. The downloaded bulletin SHA-256 was `46df506241f55a6842e8b2f8519fbe7848f650373d1970e417e1b2aaf51d495e` when reviewed on 2026-09-09.

## Verification boundary

- The value and publication metadata are versioned together in `src/lib/fiscal/inpc.ts`.
- The 2016–2025 series was previously compared against Banxico SIE series SP1 with zero mismatches; 2026 January through July match their corresponding INEGI monthly bulletins.
- `INPC_VERIFICADO` remains `false` until the runtime Banxico SIE cotejo confirms the complete loaded series through 2026-08. This prevents one reviewed monthly addition from claiming that the entire dataset passed the independent check.
- Missing periods return `null`; monetary callers retain their existing fail-closed incomplete result instead of inventing an index.
- The generic Article 17-A path no longer keeps a duplicate supplement. It reads the same canonical series as the Article 31 depreciation path.
- The scheduled strict check now uses the publication-aware expected period instead of tolerating a fixed two-month lag, and it runs on the declared `tsx` runtime.
