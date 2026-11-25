import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { Context } from 'aws-lambda';

import { SsmBotTokenProvider, type BotTokenSource } from './lib/bot-token';
import {
  buildAnomalyMessage,
  buildDailySummaryMessage,
  compareSpend,
  evaluateSpend,
  parseDailyCost,
  type AnomalyDetail,
  type CostUsageResponse,
  type DailySnapshot,
} from './lib/cost';

const TELEGRAM_API_BASE = 'https://api.telegram.org';

interface DailyEvent {
  mode?: string;
}

interface AnomalyEvent {
  source?: string;
  'detail-type'?: string;
  detail?: AnomalyDetail;
}

type MonitorEvent = DailyEvent | AnomalyEvent;

export interface MonitorResult {
  readonly mode: 'daily' | 'anomaly';
  readonly notified: boolean;
  readonly alert: boolean;
  readonly date?: string;
  readonly totalUsd?: number;
  readonly deltaUsd?: number;
}

interface MonitorConfig {
  readonly tableName: string;
  /** Name of the SSM SecureString parameter that holds the bot token. */
  readonly telegramBotTokenParamName: string;
  readonly telegramChatId: string;
  readonly dailyThresholdUsd: number;
  readonly changeThresholdPercent: number;
  readonly timeZone: string;
}

interface SnapshotItem {
  readonly snapshotDate: string;
  readonly totalUsd: number;
  readonly currency: 'USD';
  readonly byService: Record<string, number>;
  readonly capturedAt: string;
}

/** Everything the handler needs from the outside world, injectable for tests. */
export interface MonitorDependencies {
  readonly costExplorer?: CostExplorerClient;
  readonly documentClient?: DynamoDBDocumentClient;
  /**
   * Resolves the token source for a parameter name. The default keeps one
   * provider per parameter for the lifetime of the execution environment so the
   * TTL cache survives across warm invocations.
   */
  readonly botTokenSourceFactory?: (parameterName: string) => BotTokenSource;
  readonly fetchImpl?: typeof fetch;
}

interface MonitorRuntime {
  readonly costExplorer: CostExplorerClient;
  readonly documentClient: DynamoDBDocumentClient;
  readonly botTokenSourceFactory: (parameterName: string) => BotTokenSource;
  readonly fetchImpl: typeof fetch;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function loadConfig(): MonitorConfig {
  return {
    tableName: requireEnv('SNAPSHOT_TABLE_NAME'),
    telegramBotTokenParamName: requireEnv('TELEGRAM_BOT_TOKEN_PARAM_NAME'),
    telegramChatId: requireEnv('TELEGRAM_CHAT_ID'),
    dailyThresholdUsd: numberFromEnv('DAILY_THRESHOLD_USD', 50),
    changeThresholdPercent: numberFromEnv('SPEND_CHANGE_THRESHOLD_PERCENT', 30),
    timeZone: process.env.TIME_ZONE ?? 'Asia/Seoul',
  };
}

let sharedBotTokenSource:
  | { readonly parameterName: string; readonly source: SsmBotTokenProvider }
  | undefined;

/** Module-scoped so the token cache is reused by warm invocations. */
function defaultBotTokenSource(parameterName: string): BotTokenSource {
  if (sharedBotTokenSource?.parameterName !== parameterName) {
    sharedBotTokenSource = {
      parameterName,
      source: new SsmBotTokenProvider({ parameterName }),
    };
  }
  return sharedBotTokenSource.source;
}

function utcDate(offsetDays: number): string {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Cost Explorer is billed per request (currently $0.01), so one call per day is
 * made for the report itself and the previous day is served from DynamoDB when
 * a snapshot already exists.
 */
async function fetchDailyCost(runtime: MonitorRuntime, date: string): Promise<DailySnapshot> {
  const response = await runtime.costExplorer.send(
    new GetCostAndUsageCommand({
      TimePeriod: { Start: date, End: addDays(date, 1) },
      Granularity: 'DAILY',
      Metrics: ['UnblendedCost'],
      GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
    }),
  );

  return parseDailyCost(date, response as CostUsageResponse);
}

async function loadSnapshot(
  runtime: MonitorRuntime,
  tableName: string,
  date: string,
): Promise<DailySnapshot | undefined> {
  const result = await runtime.documentClient.send(
    new GetCommand({ TableName: tableName, Key: { snapshotDate: date } }),
  );

  const item = result.Item as SnapshotItem | undefined;
  if (!item) {
    return undefined;
  }

  return {
    date: item.snapshotDate,
    totalUsd: item.totalUsd,
    byService: item.byService ?? {},
  };
}

async function saveSnapshot(
  runtime: MonitorRuntime,
  tableName: string,
  snapshot: DailySnapshot,
): Promise<void> {
  const item: SnapshotItem = {
    snapshotDate: snapshot.date,
    totalUsd: snapshot.totalUsd,
    currency: 'USD',
    byService: snapshot.byService,
    capturedAt: new Date().toISOString(),
  };

  await runtime.documentClient.send(new PutCommand({ TableName: tableName, Item: item }));
}

/**
 * Resolves the bot token from Parameter Store only when a message is actually
 * sent, so a failure to read it surfaces at the notification step.
 */
async function sendTelegramMessage(
  runtime: MonitorRuntime,
  config: MonitorConfig,
  text: string,
): Promise<void> {
  const botToken = await runtime
    .botTokenSourceFactory(config.telegramBotTokenParamName)
    .getToken();

  // The bot token is part of the URL, so the URL itself is never logged.
  const response = await runtime.fetchImpl(
    `${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Telegram sendMessage failed with ${response.status}: ${body.slice(0, 300)}`,
    );
  }
}

function isAnomalyEvent(event: MonitorEvent): event is AnomalyEvent {
  return (event as AnomalyEvent)['detail-type'] === 'Anomaly Detected';
}

async function handleDaily(
  runtime: MonitorRuntime,
  config: MonitorConfig,
  context: Context,
): Promise<MonitorResult> {
  const reportDate = utcDate(-1);
  const previousDate = utcDate(-2);

  const snapshot = await fetchDailyCost(runtime, reportDate);
  const previous =
    (await loadSnapshot(runtime, config.tableName, previousDate)) ??
    (await fetchDailyCost(runtime, previousDate));

  const comparison = compareSpend(snapshot.totalUsd, previous.totalUsd);
  const evaluation = evaluateSpend(snapshot, previous.totalUsd, {
    dailyThresholdUsd: config.dailyThresholdUsd,
    changeThresholdPercent: config.changeThresholdPercent,
  });

  const message = buildDailySummaryMessage({
    snapshot,
    previousUsd: previous.totalUsd,
    previousDate,
    evaluation,
    timeZone: config.timeZone,
  });

  // Persist before notifying so a Telegram outage does not lose the snapshot.
  await saveSnapshot(runtime, config.tableName, snapshot);
  await sendTelegramMessage(runtime, config, message);

  console.info(
    JSON.stringify({
      event: 'daily_summary_sent',
      requestId: context.awsRequestId,
      reportDate,
      totalUsd: snapshot.totalUsd,
      previousUsd: previous.totalUsd,
      deltaUsd: comparison.deltaUsd,
      alert: evaluation.alert,
      reasons: evaluation.reasons,
    }),
  );

  return {
    mode: 'daily',
    notified: true,
    alert: evaluation.alert,
    date: reportDate,
    totalUsd: snapshot.totalUsd,
    deltaUsd: comparison.deltaUsd,
  };
}

async function handleAnomaly(
  runtime: MonitorRuntime,
  config: MonitorConfig,
  event: AnomalyEvent,
): Promise<MonitorResult> {
  const message = buildAnomalyMessage(event.detail ?? {});
  await sendTelegramMessage(runtime, config, message);

  console.info(
    JSON.stringify({
      event: 'anomaly_alert_sent',
      dimensionValue: event.detail?.dimensionValue,
      totalImpact: event.detail?.impact?.totalImpact,
    }),
  );

  return { mode: 'anomaly', notified: true, alert: true };
}

function createRuntime(overrides: MonitorDependencies = {}): MonitorRuntime {
  return {
    costExplorer: overrides.costExplorer ?? new CostExplorerClient({}),
    documentClient:
      overrides.documentClient ??
      DynamoDBDocumentClient.from(new DynamoDBClient({}), {
        marshallOptions: { removeUndefinedValues: true },
      }),
    botTokenSourceFactory: overrides.botTokenSourceFactory ?? defaultBotTokenSource,
    // Resolved per call so tests (and Node's global fetch) can replace it.
    fetchImpl: overrides.fetchImpl ?? ((input, init) => fetch(input, init)),
  };
}

async function runHandler(
  runtime: MonitorRuntime,
  event: MonitorEvent,
  context: Context,
): Promise<MonitorResult> {
  const config = loadConfig();

  if (isAnomalyEvent(event)) {
    return handleAnomaly(runtime, config, event);
  }

  return handleDaily(runtime, config, context);
}

const defaultRuntime = createRuntime();

/** Lambda entry point. */
export const handler = (event: MonitorEvent, context: Context): Promise<MonitorResult> =>
  runHandler(defaultRuntime, event, context);

/** Builds a handler with injected clients and token source, used by the tests. */
export function createHandler(
  overrides: MonitorDependencies = {},
): (event: MonitorEvent, context: Context) => Promise<MonitorResult> {
  const runtime = createRuntime(overrides);
  return (event, context) => runHandler(runtime, event, context);
}
