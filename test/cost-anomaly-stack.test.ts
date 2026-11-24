import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';

import {
  CostAnomalyStack,
  PLACEHOLDER_BOT_TOKEN,
  PLACEHOLDER_CHAT_ID,
} from '../lib/cost-anomaly-stack';

function buildTemplate(props: Partial<ConstructorParameters<typeof CostAnomalyStack>[2]> = {}): Template {
  const app = new App();
  const stack = new CostAnomalyStack(app, 'TestStack', {
    telegramBotToken: 'bot-token-for-tests',
    telegramChatId: '123456789',
    dailyThresholdUsd: 25,
    spendChangeThresholdPercent: 40,
    ...props,
  });
  return Template.fromStack(stack);
}

function resourcesOfType(template: Template, type: string): Array<Record<string, any>> {
  return Object.values(template.toJSON().Resources as Record<string, Record<string, any>>).filter(
    (resource) => resource.Type === type,
  );
}

describe('CostAnomalyStack', () => {
  test('keeps one snapshot table keyed by date', () => {
    const template = buildTemplate();

    template.resourceCountIs('AWS::DynamoDB::Table', 1);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'cost-snapshots',
      KeySchema: [{ AttributeName: 'snapshotDate', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  test('runs the notifier on Node.js 22 with the configured thresholds', () => {
    const template = buildTemplate();

    template.resourceCountIs('AWS::Lambda::Function', 1);
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'cost-anomaly-monitor',
      Runtime: 'nodejs22.x',
      Handler: 'index.handler',
      MemorySize: 256,
      Timeout: 60,
      Architectures: ['arm64'],
      Environment: {
        Variables: Match.objectLike({
          TELEGRAM_CHAT_ID: '123456789',
          SNAPSHOT_TABLE_NAME: Match.anyValue(),
          DAILY_THRESHOLD_USD: '25',
          SPEND_CHANGE_THRESHOLD_PERCENT: '40',
          TIME_ZONE: 'Asia/Seoul',
        }),
      },
    });
  });

  test('gives the function read/write access limited to the snapshot table', () => {
    const template = buildTemplate();
    const table = resourcesOfType(template, 'AWS::DynamoDB::Table')[0];
    const tableLogicalId = Object.keys(template.toJSON().Resources as Record<string, any>).find(
      (logicalId) =>
        (template.toJSON().Resources as Record<string, any>)[logicalId].Type ===
        'AWS::DynamoDB::Table',
    );

    expect(table).toBeDefined();
    expect(tableLogicalId).toBeDefined();

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([Match.stringLikeRegexp('^dynamodb:')]),
            Resource: Match.arrayWith([
              Match.objectLike({ 'Fn::GetAtt': [tableLogicalId, 'Arn'] }),
            ]),
          }),
        ]),
      },
    });
  });

  test('allows the function to query Cost Explorer', () => {
    const template = buildTemplate();

    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: 'Allow', Action: 'ce:*', Resource: '*' }),
        ]),
      },
    });
  });

  test('sends a daily summary at 09:00 KST from EventBridge', () => {
    const template = buildTemplate();
    const rules = resourcesOfType(template, 'AWS::Events::Rule');

    expect(rules).toHaveLength(2);
    template.hasResourceProperties('AWS::Events::Rule', {
      Name: 'cost-monitor-daily-summary',
      ScheduleExpression: 'cron(0 0 * * ? *)',
      Targets: [Match.objectLike({ Input: JSON.stringify({ mode: 'daily' }) })],
    });
  });

  test('routes Cost Anomaly Detection events to the same function', () => {
    const template = buildTemplate();

    template.hasResourceProperties('AWS::Events::Rule', {
      Name: 'cost-monitor-anomaly-events',
      EventPattern: {
        source: ['aws.ce'],
        'detail-type': ['Anomaly Detected'],
      },
      Targets: [Match.objectLike({ Arn: Match.anyValue() })],
    });
  });

  test('falls back to placeholder credentials so the stack still synthesizes', () => {
    const template = buildTemplate({ telegramBotToken: undefined, telegramChatId: undefined });

    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          TELEGRAM_BOT_TOKEN: PLACEHOLDER_BOT_TOKEN,
          TELEGRAM_CHAT_ID: PLACEHOLDER_CHAT_ID,
        }),
      },
    });
  });

  test('exposes the function and table names as outputs', () => {
    const template = buildTemplate();

    template.hasOutput('MonitorFunctionName', {});
    template.hasOutput('SnapshotTableName', {});
  });
});
