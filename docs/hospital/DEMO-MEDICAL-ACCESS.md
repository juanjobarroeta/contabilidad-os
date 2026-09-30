# Medical demo access

Demo medical signing is an explicit operator-provisioned capability for synthetic patients in an existing hospital. Normal clinical permissions and page access still apply.

Run `scripts/hospital-provision-medical-demo.ts` with a target database, company RFC, existing hospital admin email and unique uppercase reference. The operation is atomic and idempotent by reference. It refuses to overwrite an existing physician identity. It creates a new fictional patient, bedless encounter and a physician with the reserved `DEMO` credential; professional verification fields remain empty. It never marks consents signed or changes a real patient's records.

`DEMO_MEDICO_ACCESO` events bind the account, physician and exact patient IDs. `DEMO_PACIENTE` events identify synthetic patients. These event types are not writable through hospital APIs. The latest event is authoritative. Revoke by appending an event of the same type/company/reference with `{ "habilitado": false }`, preserving the actor and audit reason. Re-running the provisioning script does not reverse revocation.

Every practitioner gate receives patient context from the stored episode or patient, never from client-supplied identity. Missing context, revoked access, unmarked patients and another company fail closed. The `DEMO` credential can never use the verified-practitioner branch, even if verification fields are accidentally populated. Surgical urgency exceptions continue to require two verified practitioners.

The chart and note-author UI identify demonstration use. Saved demo notes include a fictional-data/no-clinical-validity legend inside the hashed text. This capability does not simulate inventory, billing, beds, external services or statutory reporting; the operator must keep demonstration activity synthetic and avoid financial side effects in a live company.
