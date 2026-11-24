import {
  buildAnomalyMessage,
  buildDailySummaryMessage,
  compareSpend,
  escapeHtml,
  evaluateSpend,
  formatUsd,
  parseDailyCost,
  topServices,
  type CostUsageResponse,
} from '../lambda/lib/cost';

const costExplorerResponse: CostUsageResponse = {
  ResultsByTime: [
    {
      Total: { UnblendedCost: { Amount: '12.3456', Unit: 'USD' } },
      Groups: [
        {
          Keys: ['Amazon Elastic Compute Cloud - Compute'],
          Metrics: { UnblendedCost: { Amount: '6.2', Unit: 'USD' } },
        },
        {
          Keys: ['AWS Lambda'],
          Metrics: { UnblendedCost: { Amount: '1.1045', Unit: 'USD' } },
        },
        {
          Keys: ['Amazon Simple Storage Service'],
          Metrics: { UnblendedCost: { Amount: '0', Unit: 'USD' } },
        },
      ],
    },
  ],
};

describe('parseDailyCost', () => {
  test('summarises the total and per-service cost of the reported day', () => {
    const snapshot = parseDailyCost('2026-11-23', costExplorerResponse);

    expect(snapshot.date).toBe('2026-11-23');
    expect(snapshot.totalUsd).toBe(12.35);
    expect(snapshot.byService).toEqual({
      'Amazon Elastic Compute Cloud - Compute': 6.2,
      'AWS Lambda': 1.1,
    });
  });

  test('falls back to the service groups when the response has no total', () => {
    const snapshot = parseDailyCost('2026-11-23', {
      ResultsByTime: [
        {
          Groups: [
            { Keys: ['Amazon EC2'], Metrics: { UnblendedCost: { Amount: '2.50' } } },
            { Keys: ['AWS Lambda'], Metrics: { UnblendedCost: { Amount: '0.50' } } },
          ],
        },
      ],
    });

    expect(snapshot.totalUsd).toBe(3);
  });

  test('returns an empty snapshot for a day without usage', () => {
    const snapshot = parseDailyCost('2026-11-23', { ResultsByTime: [] });

    expect(snapshot.totalUsd).toBe(0);
    expect(snapshot.byService).toEqual({});
  });
});

describe('compareSpend', () => {
  test('reports an increase in dollars and percent', () => {
    expect(compareSpend(12, 10)).toEqual({ deltaUsd: 2, deltaPercent: 20, direction: 'up' });
  });

  test('reports a decrease', () => {
    expect(compareSpend(8, 10)).toEqual({ deltaUsd: -2, deltaPercent: -20, direction: 'down' });
  });

  test('treats spend against a zero baseline as a full increase', () => {
    expect(compareSpend(5, 0)).toEqual({ deltaUsd: 5, deltaPercent: 100, direction: 'up' });
  });

  test('reports no change for identical spend', () => {
    expect(compareSpend(10, 10)).toEqual({ deltaUsd: 0, deltaPercent: 0, direction: 'flat' });
  });
});

describe('evaluateSpend', () => {
  const thresholds = { dailyThresholdUsd: 50, changeThresholdPercent: 30 };

  test('stays quiet inside both thresholds', () => {
    const evaluation = evaluateSpend({ date: '2026-11-23', totalUsd: 20, byService: {} }, 18, thresholds);

    expect(evaluation.alert).toBe(false);
    expect(evaluation.reasons).toEqual([]);
  });

  test('flags the absolute budget threshold', () => {
    const evaluation = evaluateSpend({ date: '2026-11-23', totalUsd: 55, byService: {} }, 54, thresholds);

    expect(evaluation.alert).toBe(true);
    expect(evaluation.reasons).toHaveLength(1);
    expect(evaluation.reasons[0]).toContain('$55.00');
  });

  test('flags a day-over-day jump above the change threshold', () => {
    const evaluation = evaluateSpend({ date: '2026-11-23', totalUsd: 40, byService: {} }, 20, thresholds);

    expect(evaluation.alert).toBe(true);
    expect(evaluation.reasons).toHaveLength(1);
    expect(evaluation.reasons[0]).toContain('100.0%');
  });

  test('lists every reason when both thresholds are crossed', () => {
    const evaluation = evaluateSpend({ date: '2026-11-23', totalUsd: 90, byService: {} }, 30, thresholds);

    expect(evaluation.reasons).toHaveLength(2);
  });
});

describe('message rendering', () => {
  test('renders the daily summary with the top services in descending order', () => {
    const message = buildDailySummaryMessage({
      snapshot: {
        date: '2026-11-23',
        totalUsd: 12.35,
        byService: { 'AWS Lambda': 1.1, 'Amazon Elastic Compute Cloud - Compute': 6.2 },
      },
      previousUsd: 10,
      previousDate: '2026-11-22',
      evaluation: { alert: false, reasons: [] },
      timeZone: 'Asia/Seoul',
    });

    expect(message).toContain('<b>2026-11-23</b> (Asia/Seoul)');
    expect(message).toContain('Total: <b>$12.35</b>');
    expect(message).toContain('+$2.35 (+23.5%)');
    expect(message.indexOf('Amazon Elastic Compute Cloud - Compute')).toBeLessThan(
      message.indexOf('AWS Lambda'),
    );
    expect(message).toContain('✅ Within the configured thresholds.');
  });

  test('lists the alert reasons in the summary', () => {
    const message = buildDailySummaryMessage({
      snapshot: { date: '2026-11-23', totalUsd: 61, byService: {} },
      previousUsd: 20,
      previousDate: '2026-11-22',
      evaluation: {
        alert: true,
        reasons: ['Daily spend $61.00 reached the $50.00 budget threshold.'],
      },
      timeZone: 'Asia/Seoul',
    });

    expect(message).toContain('⚠️ <b>Attention</b>');
    expect(message).toContain('• Daily spend $61.00 reached the $50.00 budget threshold.');
    expect(message).not.toContain('Within the configured thresholds');
  });

  test('escapes HTML in service names so Telegram renders the message', () => {
    const message = buildDailySummaryMessage({
      snapshot: { date: '2026-11-23', totalUsd: 1, byService: { 'A & B <beta>': 1 } },
      previousUsd: 1,
      previousDate: '2026-11-22',
      evaluation: { alert: false, reasons: [] },
      timeZone: 'Asia/Seoul',
    });

    expect(message).toContain('A &amp; B &lt;beta&gt;');
  });

  test('renders an anomaly alert with the impact and a link', () => {
    const message = buildAnomalyMessage({
      dimensionValue: 'Amazon Elastic Compute Cloud - Compute',
      accountName: 'Production',
      anomalyStartDate: '2026-11-23T00:00:00Z',
      anomalyEndDate: '2026-11-24T00:00:00Z',
      monitorName: 'Service monitor',
      anomalyDetailsLink: 'https://console.aws.amazon.com/cost-management/home#/anomaly-detection',
      impact: {
        totalActualSpend: 1301,
        totalExpectedSpend: 300,
        totalImpact: 1001,
        totalImpactPercentage: 333.67,
      },
    });

    expect(message).toContain('🚨 <b>AWS cost anomaly detected</b>');
    expect(message).toContain('Estimated impact: <b>$1,001.00</b>');
    expect(message).toContain('Actual $1,301.00 vs expected $300.00');
    expect(message).toContain('Over expected by 333.7%');
    expect(message).toContain('Window: 2026-11-23 → 2026-11-24');
    expect(message).toContain('Open in Cost Management');
  });

  test('renders an anomaly alert even when the event is sparse', () => {
    const message = buildAnomalyMessage({});

    expect(message).toContain('AWS cost anomaly detected');
    expect(message).not.toContain('Estimated impact');
  });
});

describe('formatting helpers', () => {
  test('formats dollar amounts with grouping', () => {
    expect(formatUsd(1234.5)).toBe('$1,234.50');
    expect(formatUsd(-12)).toBe('-$12.00');
  });

  test('escapes ampersands, angle brackets', () => {
    expect(escapeHtml('Tom & Jerry <3')).toBe('Tom &amp; Jerry &lt;3');
  });

  test('limits the service list to the five largest services', () => {
    const services = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`service-${index}`, index + 1]),
    );

    const top = topServices(services);

    expect(top).toHaveLength(5);
    expect(top[0]).toEqual(['service-7', 8]);
  });
});
