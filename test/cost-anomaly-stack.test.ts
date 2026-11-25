import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';

import {
  CostAnomalyStack,
  DEFAULT_TELEGRAM_BOT_TOKEN_PARAM_NAME,
  PLACEHOLDER_CHAT_ID,
} from '../lib/cost-anomaly-stack';

function buildTemplate(props: Partial<ConstructorParameters<typeof CostAnomalyStack>[2]> = {}): Template {
  const app = new App();
  const stack = new CostAnomalyStack(app, 'TestStack', {
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

function functionEnvironment(template: Template): Record<string, unknown> {
  const [fn] = resourcesOfType(template, 'AWS::Lambda::Function');
  return fn.Properties.Environment.Variables as Record<string, unknown>;
}

/** Every IAM statement in the template, flattened so individual statements can be inspected. */
function policyStatements(template: Template): Array<Record<string, any>> {
  return resourcesOfType(template, 'AWS::IAM::Policy').flatMap(
    (policy) => (policy.Properties.PolicyDocument.Statement ?? []) as Array<Record<string, any>>,
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

  test('deploys the parameter name instead of the bot token (F-01)', () => {
    const template = buildTemplate();
    const variables = functionEnvironment(template);

    expect(variables.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(variables.TELEGRAM_BOT_TOKEN_PARAM_NAME).toBe(
      DEFAULT_TELEGRAM_BOT_TOKEN_PARAM_NAME,
    );
  });

  test('accepts a custom parameter name and keeps it out of any secret slot', () => {
    const template = buildTemplate({
      telegramBotTokenParamName: '/team/shared/telegram-bot-token',
    });
    const variables = functionEnvironment(template);

    expect(variables.TELEGRAM_BOT_TOKEN_PARAM_NAME).toBe('/team/shared/telegram-bot-token');
    // The template carries the parameter name only; the value lives in SSM.
    expect(JSON.stringify(template.toJSON())).toContain('/team/shared/telegram-bot-token');
    expect(JSON.stringify(template.toJSON())).not.toContain('{{resolve:ssm-secure');
  });

  test('rejects a parameter name that is not fully qualified', () => {
    expect(() => buildTemplate({ telegramBotTokenParamName: 'telegram-bot-token' })).toThrow(
      /must be a fully qualified SSM parameter name/,
    );
  });

  test('gives the function read/write access limited to the snapshot table', () => {
    const template = buildTemplate();
    const tableLogicalId = Object.keys(template.toJSON().Resources as Record<string, any>).find(
      (logicalId) =>
        (template.toJSON().Resources as Record<string, any>)[logicalId].Type ===
        'AWS::DynamoDB::Table',
    );

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

  test('allows exactly ce:GetCostAndUsage, never ce:* (F-02)', () => {
    const template = buildTemplate();

    const costExplorer = policyStatements(template).filter((statement) =>
      String(statement.Action).startsWith('ce:'),
    );

    expect(costExplorer).toHaveLength(1);
    expect(costExplorer[0].Action).toBe('ce:GetCostAndUsage');
    expect(costExplorer[0].Resource).toBe('*');
    expect(JSON.stringify(template.toJSON())).not.toContain('ce:*');
  });

  test('allows ssm:GetParameter on the bot token parameter only (F-01)', () => {
    const template = buildTemplate();

    const ssmStatements = policyStatements(template).filter((statement) =>
      String(statement.Action).startsWith('ssm:'),
    );

    expect(ssmStatements).toHaveLength(1);
    expect(ssmStatements[0].Action).toBe('ssm:GetParameter');
    expect(ssmStatements[0].Resource).not.toBe('*');
    expect(JSON.stringify(ssmStatements[0].Resource)).toContain(
      'parameter/aws-cost-anomaly-telegram/telegram-bot-token',
    );
    expect(JSON.stringify(template.toJSON())).not.toContain('ssm:*');
  });

  test('allows decrypting the SecureString only through SSM with the aws/ssm alias (F-01)', () => {
    const template = buildTemplate();

    const kmsStatements = policyStatements(template).filter((statement) =>
      String(statement.Action).startsWith('kms:'),
    );

    expect(kmsStatements).toHaveLength(1);
    expect(kmsStatements[0].Action).toBe('kms:Decrypt');
    expect(JSON.stringify(kmsStatements[0].Condition)).toContain('kms:ViaService');
    expect(kmsStatements[0].Condition['ForAnyValue:StringEquals']).toEqual({
      'kms:ResourceAliases': 'alias/aws/ssm',
    });
    expect(JSON.stringify(template.toJSON())).not.toContain('kms:*');
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

  test('falls back to a placeholder chat id so the stack still synthesizes', () => {
    const template = buildTemplate({ telegramChatId: undefined });

    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ TELEGRAM_CHAT_ID: PLACEHOLDER_CHAT_ID }),
      },
    });
    expect(functionEnvironment(template).TELEGRAM_BOT_TOKEN).toBeUndefined();
  });

  test('exposes the function, table and parameter names as outputs', () => {
    const template = buildTemplate();

    template.hasOutput('MonitorFunctionName', {});
    template.hasOutput('SnapshotTableName', {});
    template.hasOutput('TelegramBotTokenParameterName', {});
  });
});
