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
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

/**
 * Default SSM Parameter Store parameter that holds the Telegram bot token as a
 * SecureString. It is created outside the stack (`aws ssm put-parameter ...`),
 * so the token never appears in the CloudFormation template or in the Lambda
 * configuration.
 */
export const DEFAULT_TELEGRAM_BOT_TOKEN_PARAM_NAME =
  '/aws-cost-anomaly-telegram/telegram-bot-token';

/** Placeholder used when the deploy environment does not provide a chat id. */
export const PLACEHOLDER_CHAT_ID = 'YOUR_TELEGRAM_CHAT_ID';

export interface CostAnomalyStackProps extends StackProps {
  /**
   * Name of the SSM SecureString parameter holding the bot token.
   * Defaults to {@link DEFAULT_TELEGRAM_BOT_TOKEN_PARAM_NAME}.
   */
  readonly telegramBotTokenParamName?: string;
  /**
   * Customer-managed KMS key that encrypts the SecureString parameter. When it
   * is omitted the AWS managed key `alias/aws/ssm` is assumed.
   */
  readonly telegramBotTokenEncryptionKey?: kms.IKey;
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
 *                                          ├───▶ SSM Parameter Store (bot token, SecureString)
 *                                          ├───▶ DynamoDB (daily snapshots)
 *                                          └───▶ Telegram Bot API
 */
export class CostAnomalyStack extends Stack {
  public readonly monitorFunction: lambda.IFunction;
  public readonly snapshotTable: dynamodb.Table;
  /** ARN of the SSM parameter the function is allowed to read. */
  public readonly telegramBotTokenParameterArn: string;

  constructor(scope: Construct, id: string, props: CostAnomalyStackProps = {}) {
    super(scope, id, props);

    const functionName = 'cost-anomaly-monitor';
    const botTokenParamName =
      props.telegramBotTokenParamName ?? DEFAULT_TELEGRAM_BOT_TOKEN_PARAM_NAME;
    const telegramChatId = props.telegramChatId ?? PLACEHOLDER_CHAT_ID;
    const dailyThresholdUsd = props.dailyThresholdUsd ?? 50;
    const spendChangeThresholdPercent = props.spendChangeThresholdPercent ?? 30;

    if (!botTokenParamName.startsWith('/')) {
      throw new Error(
        `telegramBotTokenParamName must be a fully qualified SSM parameter name starting with "/", ` +
          `got "${botTokenParamName}".`,
      );
    }

    if (!props.telegramChatId) {
      Annotations.of(this).addWarningV2(
        'TelegramChatIdMissing',
        'TELEGRAM_CHAT_ID is not set, so the stack will be deployed with a placeholder value and ' +
          'the notifier will not reach Telegram. Set it in the environment or in .env before ' +
          `deploying, and store the bot token in the SSM SecureString parameter ${botTokenParamName}.`,
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
        // Only the parameter name is deployed; the token itself stays in SSM.
        TELEGRAM_BOT_TOKEN_PARAM_NAME: botTokenParamName,
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

    // SEC03-BP01: the function calls GetCostAndUsage and nothing else. Cost
    // Explorer has no resource-level permissions, so the resource stays '*'
    // while the action set is narrowed to the one action the code uses.
    this.monitorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'CostExplorerQueryAccess',
        actions: ['ce:GetCostAndUsage'],
        resources: ['*'],
      }),
    );

    // SEC02-BP03: read exactly one SecureString parameter, nothing else.
    this.telegramBotTokenParameterArn = this.formatArn({
      service: 'ssm',
      resource: 'parameter',
      resourceName: botTokenParamName.replace(/^\//, ''),
    });

    this.monitorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ReadTelegramBotTokenParameter',
        actions: ['ssm:GetParameter'],
        resources: [this.telegramBotTokenParameterArn],
      }),
    );

    if (props.telegramBotTokenEncryptionKey) {
      // A customer-managed key is known at synth time, so the grant can name it.
      props.telegramBotTokenEncryptionKey.grantDecrypt(this.monitorFunction);
    } else {
      // SecureString parameters use the AWS managed key `alias/aws/ssm` unless
      // another key is supplied. Its key ARN differs per account and alias ARNs
      // are not valid IAM resources, so the statement is scoped to keys in this
      // account and Region that are used through SSM and carry that alias.
      this.monitorFunction.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'DecryptTelegramBotTokenParameter',
          actions: ['kms:Decrypt'],
          resources: [this.formatArn({ service: 'kms', resource: 'key', resourceName: '*' })],
          conditions: {
            StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` },
            'ForAnyValue:StringEquals': { 'kms:ResourceAliases': 'alias/aws/ssm' },
          },
        }),
      );
    }

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
    new CfnOutput(this, 'TelegramBotTokenParameterName', {
      description: 'SSM SecureString parameter that holds the Telegram bot token',
      value: botTokenParamName,
    });
  }
}
