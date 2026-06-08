# Security Baseline

All employees follow this baseline regardless of department. Department-specific controls are in each department's space.

## Identity
- SSO via Cognito is the only acceptable authentication path for internal tools.
- Hardware-backed MFA is required for every employee.
- Access reviews are run quarterly by HR + Engineering jointly.

## Data classification
- **Public** — wiki articles like this one, marketing copy.
- **Internal** — playbooks, runbooks, postmortems.
- **Confidential** — PII (HR), customer contracts (Sales), financial records (Finance), source code (Engineering).
- **Restricted** — credentials, signing keys, customer-supplied secrets.

Confidential data must never appear in shared wiki search results. PII lookups are mediated by a department-scoped tool (HR only).

## Reporting
Suspected compromise → security@acharness.demo and #security-incidents channel.

This document is shared across all departments.
