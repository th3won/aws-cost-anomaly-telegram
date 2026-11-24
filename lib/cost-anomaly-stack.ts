import * as path from 'node:path';

import {
  Annotations,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  Tags,
  type StackProps,
} from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

/** Placeholder used when the deploy environment does not provide Telegram credentials. */
export const PLACEHOLDER_BOT_TOKEN = 'YOUR_TELEGRAM_BOT_TOKEN';
export const PLACEHOLDER_CHAT_ID = 'YOUR_TELEGRAM_CHAT_ID';

export interface CostAnomalyStackProps extends StackProps {
  /** Telegram bot token created with @BotFather. */
  readonly telegramBotToken?: string;
  /** Telegram chat id that receives the alerts. */
  readonly telegramChatId?: string;
  /** Daily spend in USD at or above which the summary is flagged. Defaults to 50. */
  readonly dailyThresholdUsd?: number;
  /** Day-over-day spend increase, in percent, that is flagged. Defaults to 30. */
  readonly spendChangeThresholdPercent?: number;
}

/**
 * Cost monitoring pipeline:
 *
 *   EventBridge (daily 00:00 UTC) ─┐
 *   EventBridge (cost anomaly)     ─┴─▶ Lambda ─▶ Cost Explorer
 *                                          ├───▶ DynamoDB (daily snapshots)
 *                                          └───▶ Telegram Bot API
 */
export class CostAnomalyStack extends Stack {
  public readonly monitorFunction: lambda.IFunction;
  public readonly snapshotTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: CostAnomalyStackProps = {}) {
    super(scope, id, props);

    const functionName = 'cost-anomaly-monitor';
    const telegramBotToken = props.telegramBotToken ?? PLACEHOLDER_BOT_TOKEN;
    const telegramChatId = props.telegramChatId ?? PLACEHOLDER_CHAT_ID;
    const dailyThresholdUsd = props.dailyThresholdUsd ?? 50;
    const spendChangeThresholdPercent = props.spendChangeThresholdPercent ?? 30;

    if (!props.telegramBotToken || !props.telegramChatId) {
      Annotations.of(this).addWarningV2(
        'TelegramCredentialsMissing',
        'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set, so the stack will be deployed with ' +
          'placeholder values and the notifier will not reach Telegram. Set them in the ' +
          'environment or in .env before deploying.',
      );
    }

    this.snapshotTable = new dynamodb.Table(this, 'CostSnapshotTable', {
      tableName: 'cost-snapshots',
      partitionKey: { name: 'snapshotDate', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const logGroup = new logs.LogGroup(this, 'CostMonitorLogGroup', {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.monitorFunction = new NodejsFunction(this, 'CostMonitorFunction', {
      functionName,
      description: 'Sends AWS daily cost summaries and cost anomaly alerts to Telegram',
      entry: path.join(__dirname, '..', 'lambda', 'cost-monitor.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(60),
      logGroup,
      environment: {
        TELEGRAM_BOT_TOKEN: telegramBotToken,
        TELEGRAM_CHAT_ID: telegramChatId,
        SNAPSHOT_TABLE_NAME: this.snapshotTable.tableName,
        DAILY_THRESHOLD_USD: String(dailyThresholdUsd),
        SPEND_CHANGE_THRESHOLD_PERCENT: String(spendChangeThresholdPercent),
        TIME_ZONE: 'Asia/Seoul',
      },
      // Pin the SDK version in the deployment package instead of relying on the
      // version shipped with the runtime (AWS recommendation).
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        externalModules: [],
      },
    });

    // Cost Explorer does not support resource-level permissions, so the statement is account wide.
    this.monitorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'CostExplorerQueryAccess',
        actions: ['ce:*'],
        resources: ['*'],
      }),
    );
    this.snapshotTable.grantReadWriteData(this.monitorFunction);

    new events.Rule(this, 'DailySummaryRule', {
      ruleName: 'cost-monitor-daily-summary',
      description: 'Sends the previous day cost summary at 09:00 KST (00:00 UTC).',
      schedule: events.Schedule.cron({ minute: '0', hour: '0' }),
      targets: [
        new targets.LambdaFunction(this.monitorFunction, {
          event: events.RuleTargetInput.fromObject({ mode: 'daily' }),
        }),
      ],
    });

    new events.Rule(this, 'CostAnomalyRule', {
      ruleName: 'cost-monitor-anomaly-events',
      description: 'Relays AWS Cost Anomaly Detection findings from EventBridge.',
      eventPattern: {
        source: ['aws.ce'],
        detailType: ['Anomaly Detected'],
      },
      targets: [new targets.LambdaFunction(this.monitorFunction)],
    });

    Tags.of(this).add('Project', 'aws-cost-anomaly-telegram');

    new CfnOutput(this, 'MonitorFunctionName', {
      description: 'Cost monitor Lambda function name',
      value: this.monitorFunction.functionName,
    });
    new CfnOutput(this, 'SnapshotTableName', {
      description: 'DynamoDB table holding one item per monitored day',
      value: this.snapshotTable.tableName,
    });
  }
}
