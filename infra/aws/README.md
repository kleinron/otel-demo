# infra/aws

Placeholder for AWS infrastructure. No CDK app lives here yet.

When it does, this directory is the only place provider-specific code belongs. The services, load generator, and `packages/telemetry` stay free of cloud SDKs. They receive cloud configuration through environment variables.

Planned shape, not implemented here:

- One process per service: `shop`, `inventory`, `payment`, and `delivery`.
- One database per service (a separate RDS instance for each).
- OTLP export to whatever collector the environment points at. Application code does not talk to a vendor exporter.

Do not put account ids, ARNs, IP addresses, or credentials in this tree. The repository is public, and secret scanning rejects them.
