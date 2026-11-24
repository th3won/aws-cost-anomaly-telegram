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

new CostAnomalyStack(app, 'AwsCostAnomalyTelegramStack', {
  description: 'AWS cost & anomaly alert pipeline that reports daily spend and anomalies to Telegram.',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  dailyThresholdUsd: numberFromEnv('DAILY_THRESHOLD_USD'),
  spendChangeThresholdPercent: numberFromEnv('SPEND_CHANGE_THRESHOLD_PERCENT'),
});

app.synth();
