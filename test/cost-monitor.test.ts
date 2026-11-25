import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { Context } from 'aws-lambda';

import { createHandler } from '../lambda/cost-monitor';
import { DEFAULT_TOKEN_CACHE_TTL_MS, SsmBotTokenProvider } from '../lambda/lib/bot-token';

const TOKEN_PARAM = '/aws-cost-anomaly-telegram/telegram-bot-token';
const context = { awsRequestId: 'request-1' } as Context;

const anomalyEvent = {
  source: 'aws.ce',
  'detail-type': 'Anomaly Detected',
  detail: {
    dimensionValue: 'Amazon Elastic Compute Cloud - Compute',
    impact: { totalImpact: 1001, totalActualSpend: 1301, totalExpectedSpend: 300 },
  },
};

let costExplorerSend: jest.SpyInstance;
let documentClientSend: jest.SpyInstance;
let ssmSend: jest.SpyInstance;
let fetchMock: jest.Mock;
let handler: ReturnType<typeof createHandler>;
let tokenProvider: SsmBotTokenProvider;
let clock: number;

function costResponse(total: string, groups: Record<string, string> = {}) {
  return {
    ResultsByTime: [
      {
        Total: { UnblendedCost: { Amount: total, Unit: 'USD' } },
        Groups: Object.entries(groups).map(([service, amount]) => ({
          Keys: [service],
          Metrics: { UnblendedCost: { Amount: amount, Unit: 'USD' } },
        })),
      },
    ],
  };
}

function sentMessage(index = 0): Record<string, unknown> {
  expect(fetchMock).toHaveBeenCalled();
  const [, init] = fetchMock.mock.calls[index] as [string, RequestInit];
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function telegramUrl(index = 0): string {
  return String((fetchMock.mock.calls[index] as [string])[0]);
}

beforeEach(() => {
  process.env.SNAPSHOT_TABLE_NAME = 'cost-snapshots';
  process.env.TELEGRAM_BOT_TOKEN_PARAM_NAME = TOKEN_PARAM;
  process.env.TELEGRAM_CHAT_ID = '987654321';
  process.env.DAILY_THRESHOLD_USD = '50';
  process.env.SPEND_CHANGE_THRESHOLD_PERCENT = '30';
  process.env.TIME_ZONE = 'Asia/Seoul';

  clock = 1_700_000_000_000;

  costExplorerSend = jest.spyOn(CostExplorerClient.prototype, 'send');
  documentClientSend = jest.spyOn(DynamoDBDocumentClient.prototype, 'send');
  ssmSend = jest
    .spyOn(SSMClient.prototype, 'send')
    .mockResolvedValue({ Parameter: { Name: TOKEN_PARAM, Value: 'token-for-tests' } } as never);

  tokenProvider = new SsmBotTokenProvider({
    parameterName: TOKEN_PARAM,
    ttlMs: DEFAULT_TOKEN_CACHE_TTL_MS,
    now: () => clock,
  });
  handler = createHandler({ botTokenSourceFactory: () => tokenProvider });

  fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => '',
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith('TELEGRAM_') ||
      key.startsWith('SNAPSHOT_') ||
      key.startsWith('DAILY_') ||
      key.startsWith('SPEND_') ||
      key === 'TIME_ZONE'
    ) {
      delete process.env[key];
    }
  }
});

describe('handler — bot token lookup', () => {
  test('reads the token from SSM with decryption and uses it in the Telegram URL', async () => {
    costExplorerSend.mockResolvedValue(costResponse('12.35', { 'AWS Lambda': '12.35' }));
    documentClientSend.mockImplementation(async () => ({}));

    await handler({ mode: 'daily' }, context);

    expect(ssmSend).toHaveBeenCalledTimes(1);
    const command = ssmSend.mock.calls[0][0] as GetParameterCommand;
    expect(command.input).toEqual({ Name: TOKEN_PARAM, WithDecryption: true });
    expect(telegramUrl()).toContain('/bottoken-for-tests/sendMessage');
  });

  test('reuses the cached token on a warm invocation instead of calling SSM again', async () => {
    await handler(anomalyEvent, context);
    await handler(anomalyEvent, context);

    expect(ssmSend).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('reads the rotated token again once the cache TTL has passed', async () => {
    ssmSend
      .mockResolvedValueOnce({ Parameter: { Value: 'token-before-rotation' } } as never)
      .mockResolvedValueOnce({ Parameter: { Value: 'token-after-rotation' } } as never);

    await handler(anomalyEvent, context);
    expect(telegramUrl(0)).toContain('/bottoken-before-rotation/sendMessage');

    // Exactly at the TTL boundary the cached value is expired by design.
    clock += DEFAULT_TOKEN_CACHE_TTL_MS;
    await handler(anomalyEvent, context);

    expect(ssmSend).toHaveBeenCalledTimes(2);
    expect(telegramUrl(1)).toContain('/bottoken-after-rotation/sendMessage');
  });

  test('fails with a clear message when the parameter does not exist', async () => {
    const notFound = Object.assign(new Error('Parameter not found.'), {
      name: 'ParameterNotFound',
    });
    ssmSend.mockRejectedValue(notFound);

    await expect(handler(anomalyEvent, context)).rejects.toThrow(
      new RegExp(`SSM parameter ${TOKEN_PARAM} was not found`),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('fails when the parameter exists but holds an empty value', async () => {
    ssmSend.mockResolvedValue({ Parameter: { Value: '' } } as never);

    await expect(handler(anomalyEvent, context)).rejects.toThrow(/is empty/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('does not cache a failed lookup', async () => {
    ssmSend
      .mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }))
      .mockResolvedValueOnce({ Parameter: { Value: 'token-for-tests' } } as never);

    await expect(handler(anomalyEvent, context)).rejects.toThrow(/Access denied/);
    await handler(anomalyEvent, context);

    expect(ssmSend).toHaveBeenCalledTimes(2);
    expect(telegramUrl(0)).toContain('/bottoken-for-tests/sendMessage');
  });
});

describe('handler — daily summary', () => {
  test('stores the snapshot, then sends the summary to Telegram', async () => {
    costExplorerSend.mockResolvedValue(costResponse('12.35', { 'AWS Lambda': '12.35' }));
    documentClientSend.mockImplementation(async () => ({}));

    const result = await handler({ mode: 'daily' }, context);

    expect(result).toMatchObject({ mode: 'daily', notified: true, alert: false, totalUsd: 12.35 });
    expect(documentClientSend).toHaveBeenCalledWith(expect.any(PutCommand));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentMessage()).toMatchObject({ chat_id: '987654321', parse_mode: 'HTML' });
    expect(String(sentMessage().text)).toContain('AWS daily cost summary');
  });

  test('reuses the stored snapshot instead of querying Cost Explorer twice', async () => {
    costExplorerSend.mockResolvedValue(costResponse('20'));
    documentClientSend.mockImplementation(async (command: unknown) => {
      if (command instanceof GetCommand) {
        return { Item: { snapshotDate: '2026-11-22', totalUsd: 18, byService: {} } };
      }
      return {};
    });

    const result = await handler({ mode: 'daily' }, context);

    expect(costExplorerSend).toHaveBeenCalledTimes(1);
    expect(result.deltaUsd).toBe(2);
  });

  test('flags the summary when the daily threshold is crossed', async () => {
    costExplorerSend.mockResolvedValue(costResponse('75'));
    documentClientSend.mockImplementation(async (command: unknown) =>
      command instanceof GetCommand
        ? { Item: { snapshotDate: '2026-11-22', totalUsd: 70, byService: {} } }
        : {},
    );

    const result = await handler({ mode: 'daily' }, context);

    expect(result.alert).toBe(true);
    expect(String(sentMessage().text)).toContain('Attention');
  });

  test('propagates a Telegram failure after the snapshot has been saved', async () => {
    costExplorerSend.mockResolvedValue(costResponse('5'));
    documentClientSend.mockImplementation(async (command: unknown) =>
      command instanceof GetCommand
        ? { Item: { snapshotDate: '2026-11-22', totalUsd: 5, byService: {} } }
        : {},
    );
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => 'Unauthorized' });

    await expect(handler({ mode: 'daily' }, context)).rejects.toThrow(/401/);
    expect(documentClientSend).toHaveBeenCalledWith(expect.any(PutCommand));
  });
});

describe('handler — anomaly events', () => {
  test('relays an Anomaly Detected event without touching Cost Explorer', async () => {
    const result = await handler(anomalyEvent, context);

    expect(result).toMatchObject({ mode: 'anomaly', notified: true, alert: true });
    expect(costExplorerSend).not.toHaveBeenCalled();
    expect(String(sentMessage().text)).toContain('AWS cost anomaly detected');
    expect(String(sentMessage().text)).toContain('$1,001.00');
  });
});

describe('handler — configuration', () => {
  test('fails with a clear error when a required variable is missing', async () => {
    delete process.env.TELEGRAM_CHAT_ID;

    await expect(handler({ mode: 'daily' }, context)).rejects.toThrow(
      'Missing required environment variable: TELEGRAM_CHAT_ID',
    );
  });

  test('fails when the token parameter name is not configured', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN_PARAM_NAME;

    await expect(handler({ mode: 'daily' }, context)).rejects.toThrow(
      'Missing required environment variable: TELEGRAM_BOT_TOKEN_PARAM_NAME',
    );
  });
});

describe('cost queries', () => {
  test('requests one UTC day grouped by service', async () => {
    costExplorerSend.mockResolvedValue(costResponse('1'));
    documentClientSend.mockImplementation(async () => ({}));

    await handler({ mode: 'daily' }, context);

    const command = costExplorerSend.mock.calls[0][0] as GetCostAndUsageCommand;
    const input = command.input as {
      TimePeriod: { Start: string; End: string };
      Granularity: string;
      Metrics: string[];
      GroupBy: Array<{ Type: string; Key: string }>;
    };

    expect(input.Granularity).toBe('DAILY');
    expect(input.Metrics).toEqual(['UnblendedCost']);
    expect(input.GroupBy).toEqual([{ Type: 'DIMENSION', Key: 'SERVICE' }]);
    const start = new Date(`${input.TimePeriod.Start}T00:00:00.000Z`);
    const end = new Date(`${input.TimePeriod.End}T00:00:00.000Z`);
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});
