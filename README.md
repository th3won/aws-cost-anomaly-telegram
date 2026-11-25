# AWS Cost & Anomaly Telegram Alert Pipeline

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A small, self-contained FinOps pipeline built with **AWS CDK v2 (TypeScript)**.

Every morning it reports yesterday's AWS spend to a Telegram chat, grouped by service and compared
with the day before. When AWS Cost Anomaly Detection publishes a finding, the same chat gets an alert
within seconds. Every daily snapshot is kept in DynamoDB, so day-over-day comparisons do not need an
extra Cost Explorer request.

No servers, no VPC, no external services beyond the Telegram Bot API: one stack, one table, one
Lambda function and two EventBridge rules.

The Telegram bot token is **not** part of the deployment. It lives in SSM Parameter Store as a
`SecureString` and is read at runtime, so it never appears in the CloudFormation template, in
`aws lambda get-function-configuration`, or in the console — and rotating it needs no redeploy.

## Architecture

```
   every day 09:00 KST  ┌────────────────────────────────┐
   (00:00 UTC)     ────▶│ EventBridge: daily summary rule │──┐
                        └────────────────────────────────┘  │
                                                            │      ┌──────────────────────────┐
   Cost Anomaly         ┌────────────────────────────────┐  ├─────▶│ Lambda                   │
   Detection       ────▶│ EventBridge: anomaly rule       │──┘      │ cost-anomaly-monitor     │
   (aws.ce)             └────────────────────────────────┘         │ Node.js 22 · arm64       │
                                                                    └───┬──────────────┬───────┘
                                                                        │              │
                                                     GetCostAndUsage    │              │  sendMessage
                                                     (Cost Explorer)    │              │  (Telegram Bot API)
                                                                        ▼              ▼
                                                              ┌──────────────────┐  ┌──────────────┐
                                                              │ DynamoDB         │  │ Telegram     │
                                                              │ cost-snapshots   │  │ chat         │
                                                              └──────────────────┘  └──────────────┘
```

The function also reads the bot token from SSM Parameter Store (`SecureString`) by the ARN-shaped
name in `TELEGRAM_BOT_TOKEN_PARAM_NAME`; that edge is left out of the drawing to keep the flow
readable.

**What the function does**

| Trigger | Behaviour |
| --- | --- |
| Daily schedule (`{ "mode": "daily" }`) | Queries Cost Explorer for yesterday's unblended cost grouped by service, compares it with the snapshot of the day before (or asks Cost Explorer when no snapshot exists), stores the new snapshot, and posts a formatted summary with the top five services. |
| `Anomaly Detected` event (`source: aws.ce`) | Formats the anomaly impact (actual vs expected spend, percentage over expected, detection window) and posts it to the same chat with a link to the Cost Management console. |

Before either message is sent, the bot token is resolved from the SSM `SecureString` parameter named
by `TELEGRAM_BOT_TOKEN_PARAM_NAME` (`GetParameter` with `WithDecryption: true`). The resolved value is
cached in the execution environment for five minutes, so a warm invocation does not call SSM again
and a rotated token takes effect within five minutes without a deployment.

A summary is marked **⚠️ Attention** when yesterday's spend reached `DAILY_THRESHOLD_USD` or the
day-over-day increase reached `SPEND_CHANGE_THRESHOLD_PERCENT`.

## Repository layout

```
bin/app.ts                     CDK app entry point (loads .env, wires the stack)
lib/cost-anomaly-stack.ts      Stack: table, Lambda, IAM, EventBridge rules, outputs
lambda/cost-monitor.ts         Lambda handler (Cost Explorer + DynamoDB + SSM + Telegram)
lambda/lib/bot-token.ts        SSM SecureString reader with a five-minute TTL cache
lambda/lib/cost.ts             Pure helpers: parsing, comparison, thresholds, message rendering
test/cost-anomaly-stack.test.ts  Infrastructure assertions with aws-cdk-lib/assertions
test/cost-monitor.test.ts      Handler behaviour with the AWS clients and fetch stubbed
test/bot-token.test.ts         Token lookup: cache hits, TTL expiry, rotation, failure messages
test/cost.test.ts              Unit tests for the pure helpers
```

## Prerequisites

- **Node.js 22+** and npm (the same runtime as the deployed function)
- **AWS credentials** with permission to deploy the stack (`cdk bootstrap` once per account/region)
  and to create the SSM parameter (`ssm:PutParameter`)
- **AWS CDK CLI** — installed locally as a dev dependency, so `npx cdk` is enough
- **A Telegram bot** whose token and chat id you control
- **Cost Explorer enabled** in the target account (Cost Explorer is a console/API feature; billing
  data must already be available)
- Optionally, a **Cost Anomaly Detection monitor** so anomaly events are actually emitted
  (Cost Management → Cost Anomaly Detection → create a monitor for the services you care about)

### Creating the Telegram bot

1. Talk to [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the token it returns.
2. Send any message to your new bot.
3. Read your chat id from `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` — it is the
   `result[0].message.chat.id` value.

### Storing the bot token in Parameter Store

The stack never receives the token. Create the `SecureString` parameter once, before the first
deploy (or before the first invocation if you deploy without it):

```bash
aws ssm put-parameter \
  --name /aws-cost-anomaly-telegram/telegram-bot-token \
  --type SecureString \
  --value '<token-from-BotFather>' \
  --description 'Telegram bot token for the AWS cost anomaly notifier'
```

`SecureString` encrypts the value with the AWS managed key `alias/aws/ssm` unless you pass
`--key-id` with your own key. Rotate the token by overwriting the same parameter — no redeploy:

```bash
aws ssm put-parameter \
  --name /aws-cost-anomaly-telegram/telegram-bot-token \
  --type SecureString \
  --value '<new-token>' \
  --overwrite
```

The function picks the new value up within five minutes (the cache TTL). A token revoked in
BotFather keeps failing until the parameter is updated; the handler then reports
`ParameterNotFound`/`AccessDeniedException` with the exact command to fix it.

If you want a different parameter name, set `TELEGRAM_BOT_TOKEN_PARAM_NAME` (it must start with
`/`) — the stack is deployed with the name, never the value. To encrypt with a customer-managed key,
pass it as `telegramBotTokenEncryptionKey` when instantiating the stack; otherwise the role is
granted `kms:Decrypt` only for keys in the account that are used through SSM and carry the
`alias/aws/ssm` alias.

## Setup

```bash
git clone https://github.com/th3won/aws-cost-anomaly-telegram.git
cd aws-cost-anomaly-telegram
npm install
cp .env.example .env   # then edit .env with your own values
```

## Configuration

Deployment-time settings are read from the environment (or `.env`):

| Variable | Default | Description |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN_PARAM_NAME` | `/aws-cost-anomaly-telegram/telegram-bot-token` | SSM `SecureString` parameter that holds the bot token. Only the name is deployed. |
| `TELEGRAM_CHAT_ID` | — | Chat that receives the messages. Required for a working deployment. |
| `DAILY_THRESHOLD_USD` | `50` | Daily spend at or above this amount marks the summary as an alert. |
| `SPEND_CHANGE_THRESHOLD_PERCENT` | `30` | Day-over-day increase percentage that marks the summary as an alert. |
| `CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION` | CLI profile | Pin the stack to a specific account and region. |

The same values are exported to the function as environment variables, together with
`SNAPSHOT_TABLE_NAME` and `TIME_ZONE` (`Asia/Seoul`, used only for the message header). The bot
token itself is never exported: the function only knows the parameter name.

If the chat id is not set, the stack still synthesizes (with a placeholder value) and CDK prints a
warning — useful for CI, but a deployment made that way cannot reach Telegram.

### IAM

The execution role carries three statements and nothing else:

| Statement | Actions | Scope |
| --- | --- | --- |
| `CostExplorerQueryAccess` | `ce:GetCostAndUsage` | `*` (Cost Explorer has no resource-level permissions) |
| `ReadTelegramBotTokenParameter` | `ssm:GetParameter` | The one parameter ARN |
| `DecryptTelegramBotTokenParameter` | `kms:Decrypt` | Keys used via `ssm.<region>.amazonaws.com` with the `alias/aws/ssm` alias |

plus `dynamodb:GetItem`/`PutItem` and friends on the snapshot table only. If you add another Cost
Explorer call to the handler, add that one action — not `ce:*`.

## Deploy

```bash
npx cdk bootstrap          # once per account and region
aws ssm put-parameter ...  # once: store the bot token as a SecureString (see above)
npx cdk diff               # review the change set
npx cdk deploy             # deploy AwsCostAnomalyTelegramStack
```

Three outputs are printed: the function name (`MonitorFunctionName`), the snapshot table
(`SnapshotTableName`) and the parameter the function reads (`TelegramBotTokenParameterName`).

## Verify

Invoke the notifier once instead of waiting for 09:00 KST:

```bash
aws lambda invoke \
  --function-name cost-anomaly-monitor \
  --payload '{"mode":"daily"}' \
  --cli-binary-format raw-in-base64-out \
  /tmp/cost-monitor-out.json
cat /tmp/cost-monitor-out.json
```

A successful run returns `{"mode":"daily","notified":true,...}` and a summary appears in Telegram.
With the default configuration, the first run also stores a snapshot for yesterday and asks Cost
Explorer for the day before so the comparison has a baseline.

To exercise the anomaly path without waiting for a real anomaly, invoke the function with the event
shape AWS sends (see
[the EventBridge reference](https://docs.aws.amazon.com/cost-management/latest/userguide/cad-eventbridge.html)):

```bash
aws lambda invoke \
  --function-name cost-anomaly-monitor \
  --payload '{"source":"aws.ce","detail-type":"Anomaly Detected","detail":{"dimensionValue":"AWS Lambda","impact":{"totalImpact":42.5,"totalActualSpend":62.5,"totalExpectedSpend":20,"totalImpactPercentage":212.5},"anomalyStartDate":"2026-11-23T00:00:00Z","anomalyEndDate":"2026-11-24T00:00:00Z","monitorName":"Service monitor"}}' \
  --cli-binary-format raw-in-base64-out \
  /tmp/anomaly-out.json
```

## Cost

The pipeline is deliberately small:

- **Cost Explorer**: `GetCostAndUsage` is billed at $0.01 per request. A normal day makes one or two
  requests (~$0.01–0.02), because the previous day is served from DynamoDB once it has been stored.
- **Lambda**: two invocations per day, well inside the free tier at 256 MB / 60 s.
- **DynamoDB**: on-demand, one small item per day.
- **EventBridge**: scheduled and custom-pattern rules on the default bus are free.
- **SSM Parameter Store**: a standard `SecureString` parameter and `GetParameter` calls are free;
  the function makes at most one call per five minutes.

## Development

```bash
npm run build     # type check (tsc --noEmit)
npm test          # Jest: infrastructure assertions + handler and token-cache behaviour
npm run synth     # npx cdk synth
npm run diff      # npx cdk diff
```

The tests stub the AWS clients at the `send` boundary and inject the SSM client into
`SsmBotTokenProvider`, so the token cache (miss, hit, TTL expiry, rotation, failure) is verified
without calling AWS. On a machine where `cdk synth` runs out of heap under Node 20, give ts-node more
room: `NODE_OPTIONS=--max-old-space-size=4096 npx cdk synth`.

The Lambda handler bundles with esbuild at synth time, so `npx cdk synth` is a full compile of the
function code as well.

## Tear down

```bash
npx cdk destroy
```

The snapshot table is created with `RemovalPolicy.DESTROY`, so the history of daily snapshots goes
away with the stack.

## License

[MIT](LICENSE)
