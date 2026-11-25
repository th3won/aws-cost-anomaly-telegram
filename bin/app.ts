#!/usr/bin/env node
import 'source-map-support/register';

import * as dotenv from 'dotenv';
import * as cdk from 'aws-cdk-lib';

import { CostAnomalyStack } from '../lib/cost-anomaly-stack';

dotenv.config({ quiet: true });

const app = new cdk.App();

function numberFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Environment variable ${name} must be a non-negative number, got "${raw}".`);
  }
  return parsed;
}

function stringFromEnv(name: string): string | undefined {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? undefined : raw.trim();
}

new CostAnomalyStack(app, 'AwsCostAnomalyTelegramStack', {
  description: 'AWS cost & anomaly alert pipeline that reports daily spend and anomalies to Telegram.',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  // The bot token itself is stored in SSM Parameter Store; the deployment only
  // needs to know which parameter to read.
  telegramBotTokenParamName: stringFromEnv('TELEGRAM_BOT_TOKEN_PARAM_NAME'),
  telegramChatId: stringFromEnv('TELEGRAM_CHAT_ID'),
  dailyThresholdUsd: numberFromEnv('DAILY_THRESHOLD_USD'),
  spendChangeThresholdPercent: numberFromEnv('SPEND_CHANGE_THRESHOLD_PERCENT'),
});

app.synth();
