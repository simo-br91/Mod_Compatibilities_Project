# Support Workflows

## Scope

This document defines the support handling flow for:

- ingestion failures
- false positives
- customer issues
- partner integration onboarding issues

## Intake requirements

Every support ticket should capture:

- organization and project identifiers
- analysis ID or import ID
- affected pack snapshot if known
- customer impact summary
- screenshots or exported report links if available
- gateway request ID or trace ID for failing requests

## Ingestion failure workflow

1. Confirm whether the failure happened during import, analysis, evidence sync, or webhook delivery.
2. Check the gateway audit log and service health endpoints.
3. Inspect evidence sync failures, connector throttling, and OpenSearch indexing status.
4. If the failure is transient, retry once and document the retry result.
5. If the failure is reproducible, open an incident and attach the request metadata, connector name, and payload reference.

Target response:

- first response within 1 business hour during pilot
- workaround or status update within 4 business hours

## False positive workflow

1. Collect the analysis ID, finding ID, recommendation summary, and evidence excerpts.
2. Confirm whether the finding is rule-derived, evidence-derived, or model-assisted.
3. Use the analyst flow to create an evidence curation record when the finding is genuinely wrong.
4. Link the curation to the support ticket and record the mitigation status.
5. If the false positive impacts release gating, treat it as `SEV-2` until either the rule is corrected or the finding is explicitly waived.

Target response:

- acknowledgement within 1 business hour
- analyst review within 1 business day

## Customer issue workflow

1. Determine whether the issue is auth, import, findings quality, export, or integration related.
2. Reproduce with the same organization role when possible.
3. Verify quota usage and role permissions before escalating as a platform bug.
4. Provide either a clear workaround or an ETA for corrective action.
5. Close the ticket only after the customer confirms the result or the workaround is documented.

## Partner onboarding workflow

1. Confirm organization ownership and partner contact.
2. Confirm auth is working through the real OIDC flow.
3. Walk through connector installation, webhook configuration, and expected sync cadence.
4. Verify one successful import, one successful analysis, and one report export.
5. Record the pilot owner, escalation contact, and agreed success metrics.

## Support handoff rules

- Support owns customer communication.
- Analysts own false-positive adjudication and rule-curation decisions.
- Operators own release or environment health issues.
- Developers own code or schema fixes once reproduction is confirmed.
