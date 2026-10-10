Prices fetched 2026-10-10 from the AWS Price List bulk JSON for eu-central-1; re-check before relying on them.

The experiment keeps database backups off.

## Revised expectation

Revised expectation: with the agreed load profile (~2.5 req/s avg) logs are expected at 1-2 GB, below the Low scenario (5 GB); the Low column is the closest match. 5/20/50 GB were bracketing assumptions, not measurements.

<!-- prettier-ignore-start -->
# 72-hour experiment cost estimate, eu-central-1 (Frankfurt)

Prices fetched 2026-10-10 (Asia/Jerusalem; 12:17 UTC) from the AWS Price List bulk JSON. Currency USD, on-demand, before tax. Month = 730 h, so 72 h = 0.0986 month.

## Totals

Scenario = log volume / X-Ray traces. Rows: ARM64 (Graviton) Fargate; x86 in brackets.

| Scenario | Logs | Traces | No NAT ARM [x86] | 1 NAT ARM [x86] |
|---|---|---|---|---|
| Low | 5 GB | 1M | $42.15 [$43.17] | $44.97 [$45.99] |
| Expected | 20 GB | 1M | $51.65 [$52.67] | $55.25 [$56.27] |
| High | 50 GB | 5M | $92.64 [$93.66] | $97.81 [$98.83] |

Full matrix (no NAT / 1 NAT, ARM64):

| Logs \ Traces | 1M | 5M |
|---|---|---|
| 5 GB | $42.15 / $44.97 | $64.15 / $66.97 |
| 20 GB | $51.65 / $55.25 | $73.65 / $77.25 |
| 50 GB | $70.64 / $75.81 | $92.64 / $97.81 |

**Budget cap check ($75/month cap):** Low and Expected scenarios fit under $75 for the 72 h run alone (no NAT and NAT). Exceeding $75: 50 GB logs with 1M traces is near the cap ($70.64 no NAT, $75.81 NAT = over). High (50 GB, 5M traces) is over the cap ($92.64 / $97.81). The cap is monthly, so other spend in the same month also counts. Do not leave the stack running past 72 h: fixed costs alone (Fargate, RDS, ALB, IPv4, 500 metrics) run roughly $320 per 730 h month.


## Line items: Expected (20 GB logs, 1M traces), ARM64, no NAT

| Line item | Unit price | Quantity (72h) | 72h cost |
|---|---|---|---|
| ECS Fargate tasks (4 svc + 1 loadgen) | 0.011357 $/task-hr (0.25vCPU+0.5GB) | 360 | $4.0887 |
| RDS MySQL db.t4g.micro single-AZ | 0.019 $/hr | 288 | $5.4720 |
| RDS gp3 storage 20 GB x4 | 0.137 $/GB-mo | 7.89 | $1.0810 |
| RDS backup storage (1-day retention, <= free allocation) | 0.103 $/GB-mo over free | 0 | $0.0000 |
| ALB hours | 0.027 $/hr | 72 | $1.9440 |
| ALB LCU (assume 1 LCU avg) | 0.008 $/LCU-hr | 72 | $0.5760 |
| Public IPv4 (2 ALB + 5 Fargate tasks) | 0.005 $/IP-hr | 504 | $2.5200 |
| CW Logs ingestion | 0.63 $/GB | 20 | $12.6000 |
| CW Logs storage (prorated 72h, no compression credit) | 0.0324 $/GB-mo | 1.973 | $0.0639 |
| CW custom metrics (500 series, hourly prorated) | 0.30 $/metric-mo | 49.315 | $14.7945 |
| CW PutMetricData requests (assume 129,600) | 0.00001 $/req | 129,600 | $1.2960 |
| CW standard alarms x16 | 0.10 $/alarm-mo | 1.578 | $0.1578 |
| X-Ray traces stored | 0.000005 $/trace | 1,000,000 | $5.0000 |
| X-Ray traces scanned/retrieved | 0.0000005 $/trace | 1,000,000 | $0.5000 |
| CW Logs Insights scans | 0.0063 $/GB | 100 | $0.6300 |
| ECR storage 2 GB | 0.10 $/GB-mo | 0.197 | $0.0197 |
| S3 run records (assume 1 GB) | 0.0245 $/GB-mo | 0.099 | $0.0024 |
| AWS Budgets (2 budgets, within free) | 0 | 2 | $0.0000 |
| Data transfer out to internet 10 GB | 0.09 $/GB | 10 | $0.9000 |
| **Total** | | | **$51.65** |

## Line items: Expected (20 GB logs, 1M traces), ARM64, 1 NAT gateway

| Line item | Unit price | Quantity (72h) | 72h cost |
|---|---|---|---|
| ECS Fargate tasks (4 svc + 1 loadgen) | 0.011357 $/task-hr (0.25vCPU+0.5GB) | 360 | $4.0887 |
| RDS MySQL db.t4g.micro single-AZ | 0.019 $/hr | 288 | $5.4720 |
| RDS gp3 storage 20 GB x4 | 0.137 $/GB-mo | 7.89 | $1.0810 |
| RDS backup storage (1-day retention, <= free allocation) | 0.103 $/GB-mo over free | 0 | $0.0000 |
| ALB hours | 0.027 $/hr | 72 | $1.9440 |
| ALB LCU (assume 1 LCU avg) | 0.008 $/LCU-hr | 72 | $0.5760 |
| Public IPv4 (2 ALB + 1 NAT EIP) | 0.005 $/IP-hr | 216 | $1.0800 |
| NAT gateway hours | 0.052 $/hr | 72 | $3.7440 |
| NAT data processed (logs 20 GB + 5 GB other) | 0.052 $/GB | 25 | $1.3000 |
| CW Logs ingestion | 0.63 $/GB | 20 | $12.6000 |
| CW Logs storage (prorated 72h, no compression credit) | 0.0324 $/GB-mo | 1.973 | $0.0639 |
| CW custom metrics (500 series, hourly prorated) | 0.30 $/metric-mo | 49.315 | $14.7945 |
| CW PutMetricData requests (assume 129,600) | 0.00001 $/req | 129,600 | $1.2960 |
| CW standard alarms x16 | 0.10 $/alarm-mo | 1.578 | $0.1578 |
| X-Ray traces stored | 0.000005 $/trace | 1,000,000 | $5.0000 |
| X-Ray traces scanned/retrieved | 0.0000005 $/trace | 1,000,000 | $0.5000 |
| CW Logs Insights scans | 0.0063 $/GB | 100 | $0.6300 |
| ECR storage 2 GB | 0.10 $/GB-mo | 0.197 | $0.0197 |
| S3 run records (assume 1 GB) | 0.0245 $/GB-mo | 0.099 | $0.0024 |
| AWS Budgets (2 budgets, within free) | 0 | 2 | $0.0000 |
| Data transfer out to internet 10 GB | 0.09 $/GB | 10 | $0.9000 |
| **Total** | | | **$55.25** |

## Line items: High (50 GB logs, 5M traces), ARM64, 1 NAT gateway

| Line item | Unit price | Quantity (72h) | 72h cost |
|---|---|---|---|
| ECS Fargate tasks (4 svc + 1 loadgen) | 0.011357 $/task-hr (0.25vCPU+0.5GB) | 360 | $4.0887 |
| RDS MySQL db.t4g.micro single-AZ | 0.019 $/hr | 288 | $5.4720 |
| RDS gp3 storage 20 GB x4 | 0.137 $/GB-mo | 7.89 | $1.0810 |
| RDS backup storage (1-day retention, <= free allocation) | 0.103 $/GB-mo over free | 0 | $0.0000 |
| ALB hours | 0.027 $/hr | 72 | $1.9440 |
| ALB LCU (assume 1 LCU avg) | 0.008 $/LCU-hr | 72 | $0.5760 |
| Public IPv4 (2 ALB + 1 NAT EIP) | 0.005 $/IP-hr | 216 | $1.0800 |
| NAT gateway hours | 0.052 $/hr | 72 | $3.7440 |
| NAT data processed (logs 50 GB + 5 GB other) | 0.052 $/GB | 55 | $2.8600 |
| CW Logs ingestion | 0.63 $/GB | 50 | $31.5000 |
| CW Logs storage (prorated 72h, no compression credit) | 0.0324 $/GB-mo | 4.932 | $0.1598 |
| CW custom metrics (500 series, hourly prorated) | 0.30 $/metric-mo | 49.315 | $14.7945 |
| CW PutMetricData requests (assume 129,600) | 0.00001 $/req | 129,600 | $1.2960 |
| CW standard alarms x16 | 0.10 $/alarm-mo | 1.578 | $0.1578 |
| X-Ray traces stored | 0.000005 $/trace | 5,000,000 | $25.0000 |
| X-Ray traces scanned/retrieved | 0.0000005 $/trace | 5,000,000 | $2.5000 |
| CW Logs Insights scans | 0.0063 $/GB | 100 | $0.6300 |
| ECR storage 2 GB | 0.10 $/GB-mo | 0.197 | $0.0197 |
| S3 run records (assume 1 GB) | 0.0245 $/GB-mo | 0.099 | $0.0024 |
| AWS Budgets (2 budgets, within free) | 0 | 2 | $0.0000 |
| Data transfer out to internet 10 GB | 0.09 $/GB | 10 | $0.9000 |
| **Total** | | | **$97.81** |

## Line items: Low (5 GB logs, 1M traces), ARM64, no NAT

| Line item | Unit price | Quantity (72h) | 72h cost |
|---|---|---|---|
| ECS Fargate tasks (4 svc + 1 loadgen) | 0.011357 $/task-hr (0.25vCPU+0.5GB) | 360 | $4.0887 |
| RDS MySQL db.t4g.micro single-AZ | 0.019 $/hr | 288 | $5.4720 |
| RDS gp3 storage 20 GB x4 | 0.137 $/GB-mo | 7.89 | $1.0810 |
| RDS backup storage (1-day retention, <= free allocation) | 0.103 $/GB-mo over free | 0 | $0.0000 |
| ALB hours | 0.027 $/hr | 72 | $1.9440 |
| ALB LCU (assume 1 LCU avg) | 0.008 $/LCU-hr | 72 | $0.5760 |
| Public IPv4 (2 ALB + 5 Fargate tasks) | 0.005 $/IP-hr | 504 | $2.5200 |
| CW Logs ingestion | 0.63 $/GB | 5 | $3.1500 |
| CW Logs storage (prorated 72h, no compression credit) | 0.0324 $/GB-mo | 0.493 | $0.0160 |
| CW custom metrics (500 series, hourly prorated) | 0.30 $/metric-mo | 49.315 | $14.7945 |
| CW PutMetricData requests (assume 129,600) | 0.00001 $/req | 129,600 | $1.2960 |
| CW standard alarms x16 | 0.10 $/alarm-mo | 1.578 | $0.1578 |
| X-Ray traces stored | 0.000005 $/trace | 1,000,000 | $5.0000 |
| X-Ray traces scanned/retrieved | 0.0000005 $/trace | 1,000,000 | $0.5000 |
| CW Logs Insights scans | 0.0063 $/GB | 100 | $0.6300 |
| ECR storage 2 GB | 0.10 $/GB-mo | 0.197 | $0.0197 |
| S3 run records (assume 1 GB) | 0.0245 $/GB-mo | 0.099 | $0.0024 |
| AWS Budgets (2 budgets, within free) | 0 | 2 | $0.0000 |
| Data transfer out to internet 10 GB | 0.09 $/GB | 10 | $0.9000 |
| **Total** | | | **$42.15** |

### x86 Fargate difference

x86 task rate = 0.25 x 0.04656 + 0.5 x 0.00511 = $0.014195/task-hr vs ARM 0.25 x 0.03725 + 0.5 x 0.00409 = $0.0113575. For 360 task-hours: x86 $5.11 vs ARM $4.09 (+$1.02). Everything else is identical.

## Top 3 cost drivers (Expected, ARM64, no NAT)

1. CW custom metrics (500 series, hourly prorated): $14.79
2. CW Logs ingestion: $12.60
3. RDS MySQL db.t4g.micro single-AZ: $5.47

Top 3 in High + NAT: CW Logs ingestion $31.50; X-Ray traces stored $25.00; CW custom metrics (500 series, hourly prorated) $14.79.

## Assumptions
- Fargate 0.25 vCPU / 0.5 GB per task, 5 tasks running the full 72 h, 20 GB default ephemeral storage (no extra charge; only >20 GB is billed at $0.000132/GB-h). No Savings Plans / Spot.
- ADOT collector runs as a sidecar inside the same task and shares its 0.25 vCPU / 0.5 GB: no separate charge. (Sidecar contention may force larger task sizes; not priced.)
- RDS MySQL priced; PostgreSQL db.t4g.micro would differ slightly (not fetched). gp3 20 GB: baseline IOPS/throughput are included at this size so no PIOPS/throughput charge. Automated backup storage up to 100% of provisioned storage is free, so 1-day retention costs $0 (the bulk file only lists the overage rate of $0.103/GB-mo; the free allocation rule is from RDS docs, not verified in the bulk JSON). DBs not publicly accessible (no public IPv4). RDS Performance Insights/Database Insights, Enhanced Monitoring off.
- ALB: 1 LCU average per hour (assumption; real LCU depends on connections/bytes/rules). ALB spans 2 AZs, so 2 public IPv4.
- Public IPv4 charged at $0.005/h per in-use address. No-NAT case: 5 Fargate tasks have public IPs. NAT case: tasks private, 1 NAT EIP.
- NAT gateway data processed = log GB + 5 GB (ECR image pulls ~2 GB, traces/metrics ~3 GB). Assumed; no VPC endpoints. Intra-region cross-AZ transfer ignored. NAT per-GB uses the standard NAT price.
- CloudWatch Logs: Standard class, custom log ingestion $0.63/GB; storage billed at ingested size, prorated 72 h (compression ignored, conservative). Logs Insights 100 GB scanned at $0.0063/GB.
- Metrics: 500 custom metric series for the whole 72 h at $0.30 (first 10k tier), prorated hourly. PutMetricData requests: ASSUMED 1 call per task per 10 s (129,600 calls) at $0.01/1000.
- 16 standard-resolution alarms, prorated.
- X-Ray: "recorded" = stored ($5/M), "scanned" = scanned/retrieved ($0.50/M) once per trace.
- ECR 2 GB, S3 1 GB (requests ignored), data transfer out 10 GB at the first-tier $0.09/GB.
- AWS Budgets: 2 budgets, within free (first 2 action-enabled budget-days free, then $0.10/budget-day; plain budgets $0).
- Free tiers (CW 5 GB log ingestion/10 metrics/10 alarms, X-Ray 100k traces/1M scans, data-transfer 100 GB/month) NOT deducted: account-dependent, so totals are conservative. Taxes, Support plan, KMS, secrets, Route 53, certificates (ACM public free) not included.
- Scenario definitions: Low = 5 GB logs/1M traces; Expected = 20 GB/1M; High = 50 GB/5M.

## Price sources (all fetched 2026-10-10, Asia/Jerusalem; publicationDate of each file in brackets)
| Price | Source URL | File publicationDate |
|---|---|---|
| Fargate vCPU/GB ARM & x86, ephemeral | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECS/current/eu-central-1/index.json | 2026-09-11 |
| RDS db.t4g.micro MySQL, gp3, PIOPS, backup | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/eu-central-1/index.json | 2026-10-06 |
| ALB hour & LCU | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSELB/current/eu-central-1/index.json | 2026-09-11 |
| Public IPv4 | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonVPC/current/eu-central-1/index.json | n/a (queried) |
| NAT gateway | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/eu-central-1/index.json | (usagetype EUC1-NatGateway-Hours/Bytes) |
| CloudWatch logs, metrics, alarms, Insights, API requests | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonCloudWatch/current/eu-central-1/index.json | 2026-10-07 |
| X-Ray | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSXRay/current/eu-central-1/index.json | 2026-09-11 |
| ECR | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECR/current/eu-central-1/index.json | 2026-09-11 |
| S3 Standard | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/eu-central-1/index.json | 2026-09-28 |
| Data transfer out | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/eu-central-1/index.json | 2026-09-16 |
| Budgets | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSBudgets/current/index.json | 2026-09-11 |

## Not verified
- RDS free backup allocation (rule, not in bulk JSON). PostgreSQL price not fetched. Free-tier amounts only partially visible in the bulk JSON. Usage quantities (LCU, NAT GB, PutMetricData calls) are assumptions, not prices.
<!-- prettier-ignore-end -->
