# Production Incident Runbook

This runbook is read by all on-call engineers across departments. It is the first thing to open during a Sev1 / Sev2.

## Severity definitions
- **Sev1** — full outage, customer impact > 5 min.
- **Sev2** — degraded service, customer impact under SLO.
- **Sev3** — internal-only impact.

## First 5 minutes
1. Acknowledge the page in PagerDuty.
2. Open the incident channel `#inc-<id>` (auto-created).
3. Post the initial status: scope, impact, suspected component.
4. Page the on-call SRE if not already paged.

## Communication
- External status page is updated by the incident commander, not the responder.
- Customer communication goes through Sales (sales-ops on-call) for Sev1.

## Postmortem
- Drafted within 48h, reviewed in the weekly engineering review, published to the wiki.

This document is shared across all departments.
