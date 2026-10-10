Prices fetched 2026-10-10 from the AWS Price List bulk JSON for eu-central-1; re-check before relying on them.

The experiment keeps database backups off.

## Revised expectation

Revised expectation: with the agreed load profile (~2.5 req/s avg) logs are expected at 1-2 GB, below the Low scenario (5 GB); the Low column is the closest match. 5/20/50 GB were bracketing assumptions, not measurements. Traces are expected to be ~100% of checkout/payment/delivery traces (~9k over the run) plus sampled browse/cart traffic, so X-Ray cost is well under the 1M-trace Expected line.

<!-- prettier-ignore-start -->
# 72-hour experiment cost estimate, eu-central-1 (Frankfurt)

Prices fetched 2026-10-10 (Asia/Jerusalem; 12:17 UTC) from the AWS Price List bulk JSON. Currency USD, on-demand, before tax. Month = 730 h, so 72 h = 0.0986 month.

## Totals

Scenario = log volume / X-Ray traces. Rows: ARM64 (Graviton) Fargate; x86 in brackets.

| Scenario | Logs | Traces | No NAT ARM [x86] | 1 NAT ARM [x86] |
|---|---|---|---|---|
| Low | 5 GB | 1M | $44.50 [$45.52] | $47.33 [$48.35] |
| Expected | 20 GB | 1M | $54.00 [$55.02] | $57.61 [$58.63] |
| High | 50 GB | 5M | $95.00 [$96.02] | $100.16 [$101.18] |

Full matrix (no NAT / 1 NAT, ARM64):

| Logs \ Traces | 1M | 5M |
|---|---|---|
| 5 GB | $44.50 / $47.33 | $66.50 / $69.33 |
| 20 GB | $54.00 / $57.61 | $76.00 / $79.61 |
| 50 GB | $73.00 / $78.16 | $95.00 / $100.16 |

**Budget cap check ($75/month cap):** Low (5 GB, 1M traces: $44.50 no NAT, $47.33 NAT) and Expected (20 GB, 1M: $54.00 / $57.61) fit under $75 for the 72 h run alone. 5 GB with 5M traces also fits ($66.50 / $69.33). Exceeding $75: 20 GB with 5M traces ($76.00 / $79.61); 50 GB with 1M traces is still under with no NAT ($73.00) and over with NAT ($78.16). High (50 GB, 5M traces) is over the cap ($95.00 / $100.16). The cap is monthly, so other spend in the same month also counts. Do not leave the stack running past 72 h: fixed costs alone (Fargate including the Grafana task, RDS, ALB, IPv4, one Secrets Manager secret, and 500 metrics) run roughly $320 per 730 h month. Grafana GetMetricData at this evaluation rate adds about $13 over that same month.


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
| CW standard alarms (not generated) | 0.10 $/alarm-mo | 0 | $0.0000 |
| Grafana on Fargate (1 extra task, ARM) | 0.011357 $/task-hr (0.25vCPU+0.5GB) | 72 | $0.8177 |
| Secrets Manager (1 secret) | 0.40 $/secret-mo | 0.0986 | $0.0394 |
| Public IPv4 (Grafana listener, if public) | 0.005 $/IP-hr | 72 | $0.3600 |
| CW GetMetricData (Grafana, ~30 rules/min) | 0.00001 $/metric | 129,600 | $1.2960 |
| X-Ray traces stored | 0.000005 $/trace | 1,000,000 | $5.0000 |
| X-Ray traces scanned/retrieved | 0.0000005 $/trace | 1,000,000 | $0.5000 |
| CW Logs Insights scans | 0.0063 $/GB | 100 | $0.6300 |
| ECR storage 2 GB | 0.10 $/GB-mo | 0.197 | $0.0197 |
| S3 run records (assume 1 GB) | 0.0245 $/GB-mo | 0.099 | $0.0024 |
| AWS Budgets (2 budgets, within free) | 0 | 2 | $0.0000 |
| Data transfer out to internet 10 GB | 0.09 $/GB | 10 | $0.9000 |
| **Total** | | | **$54.00** |

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
| CW standard alarms (not generated) | 0.10 $/alarm-mo | 0 | $0.0000 |
| Grafana on Fargate (1 extra task, ARM) | 0.011357 $/task-hr (0.25vCPU+0.5GB) | 72 | $0.8177 |
| Secrets Manager (1 secret) | 0.40 $/secret-mo | 0.0986 | $0.0394 |
| Public IPv4 (Grafana listener, if public) | 0.005 $/IP-hr | 72 | $0.3600 |
| CW GetMetricData (Grafana, ~30 rules/min) | 0.00001 $/metric | 129,600 | $1.2960 |
| X-Ray traces stored | 0.000005 $/trace | 1,000,000 | $5.0000 |
| X-Ray traces scanned/retrieved | 0.0000005 $/trace | 1,000,000 | $0.5000 |
| CW Logs Insights scans | 0.0063 $/GB | 100 | $0.6300 |
| ECR storage 2 GB | 0.10 $/GB-mo | 0.197 | $0.0197 |
| S3 run records (assume 1 GB) | 0.0245 $/GB-mo | 0.099 | $0.0024 |
| AWS Budgets (2 budgets, within free) | 0 | 2 | $0.0000 |
| Data transfer out to internet 10 GB | 0.09 $/GB | 10 | $0.9000 |
| **Total** | | | **$57.61** |

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
| CW standard alarms (not generated) | 0.10 $/alarm-mo | 0 | $0.0000 |
| Grafana on Fargate (1 extra task, ARM) | 0.011357 $/task-hr (0.25vCPU+0.5GB) | 72 | $0.8177 |
| Secrets Manager (1 secret) | 0.40 $/secret-mo | 0.0986 | $0.0394 |
| Public IPv4 (Grafana listener, if public) | 0.005 $/IP-hr | 72 | $0.3600 |
| CW GetMetricData (Grafana, ~30 rules/min) | 0.00001 $/metric | 129,600 | $1.2960 |
| X-Ray traces stored | 0.000005 $/trace | 5,000,000 | $25.0000 |
| X-Ray traces scanned/retrieved | 0.0000005 $/trace | 5,000,000 | $2.5000 |
| CW Logs Insights scans | 0.0063 $/GB | 100 | $0.6300 |
| ECR storage 2 GB | 0.10 $/GB-mo | 0.197 | $0.0197 |
| S3 run records (assume 1 GB) | 0.0245 $/GB-mo | 0.099 | $0.0024 |
| AWS Budgets (2 budgets, within free) | 0 | 2 | $0.0000 |
| Data transfer out to internet 10 GB | 0.09 $/GB | 10 | $0.9000 |
| **Total** | | | **$100.16** |

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
| CW standard alarms (not generated) | 0.10 $/alarm-mo | 0 | $0.0000 |
| Grafana on Fargate (1 extra task, ARM) | 0.011357 $/task-hr (0.25vCPU+0.5GB) | 72 | $0.8177 |
| Secrets Manager (1 secret) | 0.40 $/secret-mo | 0.0986 | $0.0394 |
| Public IPv4 (Grafana listener, if public) | 0.005 $/IP-hr | 72 | $0.3600 |
| CW GetMetricData (Grafana, ~30 rules/min) | 0.00001 $/metric | 129,600 | $1.2960 |
| X-Ray traces stored | 0.000005 $/trace | 1,000,000 | $5.0000 |
| X-Ray traces scanned/retrieved | 0.0000005 $/trace | 1,000,000 | $0.5000 |
| CW Logs Insights scans | 0.0063 $/GB | 100 | $0.6300 |
| ECR storage 2 GB | 0.10 $/GB-mo | 0.197 | $0.0197 |
| S3 run records (assume 1 GB) | 0.0245 $/GB-mo | 0.099 | $0.0024 |
| AWS Budgets (2 budgets, within free) | 0 | 2 | $0.0000 |
| Data transfer out to internet 10 GB | 0.09 $/GB | 10 | $0.9000 |
| **Total** | | | **$44.50** |

### x86 Fargate difference

x86 task rate = 0.25 x 0.04656 + 0.5 x 0.00511 = $0.014195/task-hr vs ARM 0.25 x 0.03725 + 0.5 x 0.00409 = $0.0113575. For 360 task-hours: x86 $5.11 vs ARM $4.09 (+$1.02). The Grafana task is priced as ARM in both columns. Everything else is identical.

## Top 3 cost drivers (Expected, ARM64, no NAT)

1. CW custom metrics (500 series, hourly prorated): $14.79
2. CW Logs ingestion: $12.60
3. RDS MySQL db.t4g.micro single-AZ: $5.47

Top 3 in High + NAT: CW Logs ingestion $31.50; X-Ray traces stored $25.00; CW custom metrics (500 series, hourly prorated) $14.79.

## Assumptions
- Fargate 0.25 vCPU / 0.5 GB per task, 5 workload tasks plus 1 Grafana task running the full 72 h, 20 GB default ephemeral storage (no extra charge; only >20 GB is billed at $0.000132/GB-h). No Savings Plans / Spot. Grafana uses the same ARM task-hour price: 0.25 x 0.03725 + 0.5 x 0.00409 = $0.0113575, shown as 0.011357. 72 h x $0.0113575 = $0.8177.
- ADOT collector runs as a sidecar inside the same task and shares its 0.25 vCPU / 0.5 GB: no separate charge. (Sidecar contention may force larger task sizes; not priced.)
- RDS MySQL priced; PostgreSQL db.t4g.micro would differ slightly (not fetched). gp3 20 GB: baseline IOPS/throughput are included at this size so no PIOPS/throughput charge. Automated backup storage up to 100% of provisioned storage is free, so 1-day retention costs $0 (the bulk file only lists the overage rate of $0.103/GB-mo; the free allocation rule is from RDS docs, not verified in the bulk JSON). DBs not publicly accessible (no public IPv4). RDS Performance Insights/Database Insights, Enhanced Monitoring off.
- ALB: 1 LCU average per hour (assumption; real LCU depends on connections/bytes/rules). ALB spans 2 AZs, so 2 public IPv4.
- Public IPv4 charged at $0.005/h per in-use address. No-NAT case: 5 workload Fargate tasks have public IPs. NAT case: those tasks are private, plus 1 NAT EIP. The Grafana listener adds one more public IPv4 (72 h x $0.005 = $0.36) when it is public. That line is included in every total in this file. Drop $0.36 if the listener is private. It is not inside the "5 Fargate tasks" row.
- A full 730 h month of the fixed items named in the budget check (no NAT address count) is about $321, written as roughly $320: 6 ARM tasks x 730 h x $0.0113575 = $49.75; 4 x db.t4g.micro x 730 h x $0.019 = $55.48; 80 GB gp3 x $0.137 = $10.96; ALB 730 h x ($0.027 + $0.008) = $25.55; 8 public IPv4 (2 ALB + 5 workload tasks + Grafana) x 730 h x $0.005 = $29.20; one secret $0.40; 500 metrics x $0.30 = $150. Sum $321.34. Grafana GetMetricData over that month at 30 rules/minute is 30 x 60 x 730 x $0.00001 = $13.14.
- NAT gateway data processed = log GB + 5 GB (ECR image pulls ~2 GB, traces/metrics ~3 GB). Assumed; no VPC endpoints. Intra-region cross-AZ transfer ignored. NAT per-GB uses the standard NAT price.
- CloudWatch Logs: Standard class, custom log ingestion $0.63/GB; storage billed at ingested size, prorated 72 h (compression ignored, conservative). Logs Insights 100 GB scanned at $0.0063/GB.
- Metrics: 500 custom metric series for the whole 72 h at $0.30 (first 10k tier), prorated hourly. PutMetricData requests: ASSUMED 1 call per task per 10 s (129,600 calls) at $0.01/1000.
- CloudWatch standard alarms are not generated. The previous 16-alarm line is quantity 0 ($0). Grafana evaluates the catalog. About 30 rules every minute for 72 h is 30 x 60 x 72 = 129,600 GetMetricData metric requests at $0.01 per 1,000 metrics ($0.00001 per metric) = $1.2960. The rule count is an assumption; the unit price is from the CloudWatch bulk JSON (operation GetMetricData, usagetype EUC1-CW:GMD-Metrics).
- One Secrets Manager secret at $0.40 per secret (price-list unit Secrets, description "$0.40 per Secret"). 72 h uses this file's 0.0986 month factor: 0.0986 x $0.40 = $0.0394. The bulk JSON description does not contain the word "month"; the same 730 h month used for the other monthly rates is applied here. Secrets Manager API requests are $0.05 per 10,000 ($0.000005 each) and have no call volume in this estimate, so they are not added.
- X-Ray: "recorded" = stored ($5/M), "scanned" = scanned/retrieved ($0.50/M) once per trace.
- ECR 2 GB, S3 1 GB (requests ignored), data transfer out 10 GB at the first-tier $0.09/GB.
- AWS Budgets: 2 budgets, within free (first 2 action-enabled budget-days free, then $0.10/budget-day; plain budgets $0).
- Free tiers (CW 5 GB log ingestion/10 metrics/10 alarms, X-Ray 100k traces/1M scans, data-transfer 100 GB/month) NOT deducted: account-dependent, so totals are conservative. The 10-alarm free tier does not apply here because no CloudWatch alarms are generated. Taxes, Support plan, KMS, further secrets beyond the one priced above, Secrets Manager API calls, Route 53, certificates (ACM public free) not included.
- Scenario definitions: Low = 5 GB logs/1M traces; Expected = 20 GB/1M; High = 50 GB/5M.

## Price sources (all fetched 2026-10-10, Asia/Jerusalem; publicationDate of each file in brackets)
| Price | Source URL | File publicationDate |
|---|---|---|
| Fargate vCPU/GB ARM & x86, ephemeral | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECS/current/eu-central-1/index.json | 2026-09-11 |
| RDS db.t4g.micro MySQL, gp3, PIOPS, backup | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/eu-central-1/index.json | 2026-10-06 |
| ALB hour & LCU | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSELB/current/eu-central-1/index.json | 2026-09-11 |
| Public IPv4 | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonVPC/current/eu-central-1/index.json | n/a (queried) |
| NAT gateway | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/eu-central-1/index.json | (usagetype EUC1-NatGateway-Hours/Bytes) |
| CloudWatch logs, metrics, alarms, Insights, API requests, GetMetricData | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonCloudWatch/current/eu-central-1/index.json | 2026-10-07 |
| Secrets Manager secret ($0.40) and API requests ($0.05/10,000) | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSSecretsManager/current/eu-central-1/index.json | 2026-09-11 |
| X-Ray | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSXRay/current/eu-central-1/index.json | 2026-09-11 |
| ECR | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECR/current/eu-central-1/index.json | 2026-09-11 |
| S3 Standard | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/eu-central-1/index.json | 2026-09-28 |
| Data transfer out | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/eu-central-1/index.json | 2026-09-16 |
| Budgets | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSBudgets/current/index.json | 2026-09-11 |

## Not verified
- RDS free backup allocation (rule, not in bulk JSON). PostgreSQL price not fetched. Free-tier amounts only partially visible in the bulk JSON. Usage quantities (LCU, NAT GB, PutMetricData calls, ~30 Grafana rules/minute) are assumptions, not prices.
- Secrets Manager: fetched 2026-10-10 (~14:19 UTC) from the AWSSecretsManager eu-central-1 bulk JSON (publicationDate 2026-09-11T12:46:10Z). There is no AmazonSecretsManager offer file (that URL 404s); the price-list offer code is AWSSecretsManager. Verified rate: $0.40 per secret, unit Secrets, description "$0.40 per Secret" (SKU N7A3USAT9EUMXNZ4, usagetype EUC1-AWSSecretsManager-Secrets). The price dimension does not say "per month". The $0.0394 figure prorates that rate with this file's 0.0986 month (72/730). API-request price verified at $0.05 per 10,000 (unit price $0.000005); call count not verified because none was assumed.
- GetMetricData: same CloudWatch file, publicationDate 2026-10-07T11:55:40Z, re-read 2026-10-10. $0.01 per 1,000 metrics requested (unit price $0.00001 per metric), operation GetMetricData, usagetype EUC1-CW:GMD-Metrics, description "$0.01 per 1,000 metrics requested using GetMetricData API - EU (Frankfurt)".
<!-- prettier-ignore-end -->
