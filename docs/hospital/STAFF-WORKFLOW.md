# Staff workflow and medical authorization

Hospital clinical writers can record ordinary preparation checks and operational patient status changes, including operating-room entry. Entry still checks signed consent/preparation evidence. A surgical emergency exception still requires two separately authenticated, verified physicians. Read-only users remain unable to write.

The chart receives valid next statuses from the API. A deferred procedure may return from preparation to assessment or the ward. It cannot skip surgery directly into postoperative recovery. Errors name the missing step in Spanish.

## Discharge handoff

1. A clinician with clinical-write and discharge permissions chooses **Autorizar alta**, reviews the clinical summary and aftercare, and signs using their own verified (or bounded demo) identity.
2. This creates an immutable medical note and a company/episode-scoped `ALTA_AUTORIZACION` event. The patient remains admitted, the bed remains occupied, and no discharge accounting is posted yet.
3. Staff with clinical-write and discharge permissions choose **Registrar salida**. The server uses the signed clinical data; staff cannot replace the diagnosis, summary, physician or instructions. The bed release, stay closure and existing accounting happen once, at departure. Staff identity and the authorizing clinician remain distinct in the audit trail.
4. Staff can **Suspender alta** with a reason. It requires a new clinician authorization to proceed.

Clinicians can still select **El paciente sale ahora** to authorize and record departure together. No attending-physician assignment is needed to sign: the authenticated practitioner's identity is used.

An authorization expires after 24 hours, is superseded by a later authorization/revocation/completion, and becomes invalid when episode metadata changes or its signed note is corrected or fails signature verification. Staff must suspend a discharge when the patient's condition changes; routine new vitals do not automatically revoke the clinical decision. The API checks freshness again under an episode lock before recording departure. Episode edits, transfers and cancellation use the same lock to prevent concurrent stale writes.

## Validation

- `src/lib/hospital/alta-autorizacion.test.ts`: expiry, correction/tampering, episode/author mismatch, supersession, closed episodes and state choices.
- `scripts/hospital-staff-workflow-regression.ts`: 23 real HTTP/PostgreSQL checks on a guarded synthetic local database, including staff preparation, consent checks, physician authorization, staff departure, revocation, changed episodes, denied tampering and concurrent departure completion.
- All 651 hospital unit tests pass; TypeScript check and frontend production build pass.
- Browser verification was declined for the local test page; visual verification remains outstanding.
