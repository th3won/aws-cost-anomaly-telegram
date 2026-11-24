/**
 * Pure helpers shared by the cost monitor Lambda and its unit tests.
 *
 * Everything here is free of AWS SDK imports so the behaviour can be tested
 * without credentials or network access.
 */

export interface CostMetricValue {
  readonly Amount?: string;
  readonly Unit?: string;
}

export interface CostUsageGroup {
  readonly Keys?: string[];
  readonly Metrics?: Record<string, CostMetricValue>;
}

export interface CostUsageResult {
  readonly Total?: Record<string, CostMetricValue>;
  readonly Groups?: CostUsageGroup[];
}

/** The subset of the Cost Explorer GetCostAndUsage response this project reads. */
export interface CostUsageResponse {
  readonly ResultsByTime?: CostUsageResult[];
}

export interface DailySnapshot {
  /** ISO date (YYYY-MM-DD) the snapshot describes, in UTC. */
  readonly date: string;
  readonly totalUsd: number;
  /** Unblended cost per AWS service, largest first when rendered. */
  readonly byService: Record<string, number>;
}

export interface Thresholds {
  readonly dailyThresholdUsd: number;
  readonly changeThresholdPercent: number;
}

export interface SpendComparison {
  readonly deltaUsd: number;
  readonly deltaPercent: number;
  readonly direction: 'up' | 'down' | 'flat';
}

export interface SpendEvaluation {
  readonly alert: boolean;
  readonly reasons: string[];
}

/** The fields of an "Anomaly Detected" EventBridge event that are shown to the user. */
export interface AnomalyDetail {
  readonly accountName?: string;
  readonly anomalyStartDate?: string;
  readonly anomalyEndDate?: string;
  readonly dimensionValue?: string;
  readonly monitorName?: string;
  readonly anomalyDetailsLink?: string;
  readonly impact?: {
    readonly maxImpact?: number;
    readonly totalActualSpend?: number;
    readonly totalExpectedSpend?: number;
    readonly totalImpact?: number;
    readonly totalImpactPercentage?: number;
  };
  readonly rootCauses?: Array<{
    readonly service?: string;
    readonly linkedAccountName?: string;
    readonly region?: string;
  }>;
}

/** Telegram rejects messages longer than 4096 characters. */
export const TELEGRAM_MESSAGE_LIMIT = 4000;
export const MAX_SERVICES_IN_MESSAGE = 5;

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function formatUsd(amount: number, digits = 2): string {
  const sign = amount < 0 ? '-' : '';
  return `${sign}$${Math.abs(amount).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(message: string, limit = TELEGRAM_MESSAGE_LIMIT): string {
  if (message.length <= limit) {
    return message;
  }
  return `${message.slice(0, limit - 20)}\n…(truncated)`;
}

/**
 * Turns one day of grouped Cost Explorer output into a snapshot.
 * Falls back to summing the service groups when the response has no total.
 */
export function parseDailyCost(date: string, response: CostUsageResponse): DailySnapshot {
  const byService: Record<string, number> = {};
  const result = response.ResultsByTime?.[0];

  for (const group of result?.Groups ?? []) {
    const service = group.Keys?.[0] ?? 'Unknown';
    const amount = Number(group.Metrics?.UnblendedCost?.Amount ?? '0');
    if (!Number.isFinite(amount) || amount === 0) {
      continue;
    }
    byService[service] = round((byService[service] ?? 0) + amount);
  }

  const totalAmount = result?.Total?.UnblendedCost?.Amount;
  const parsedTotal = totalAmount === undefined ? Number.NaN : Number(totalAmount);
  const totalUsd = Number.isFinite(parsedTotal)
    ? round(parsedTotal)
    : round(Object.values(byService).reduce((sum, value) => sum + value, 0));

  return { date, totalUsd, byService };
}

export function compareSpend(currentUsd: number, previousUsd: number): SpendComparison {
  const deltaUsd = round(currentUsd - previousUsd);
  let deltaPercent = 0;
  if (previousUsd > 0) {
    deltaPercent = round((deltaUsd / previousUsd) * 100, 1);
  } else if (currentUsd > 0) {
    deltaPercent = 100;
  }

  return {
    deltaUsd,
    deltaPercent,
    direction: deltaUsd > 0 ? 'up' : deltaUsd < 0 ? 'down' : 'flat',
  };
}

/**
 * Decides whether the day is worth flagging.
 * A day is an alert when it reaches the absolute budget threshold, or when the
 * day-over-day increase reaches the relative threshold.
 */
export function evaluateSpend(
  snapshot: DailySnapshot,
  previousUsd: number,
  thresholds: Thresholds,
): SpendEvaluation {
  const reasons: string[] = [];

  if (snapshot.totalUsd >= thresholds.dailyThresholdUsd) {
    reasons.push(
      `Daily spend ${formatUsd(snapshot.totalUsd)} reached the ${formatUsd(
        thresholds.dailyThresholdUsd,
      )} budget threshold.`,
    );
  }

  const comparison = compareSpend(snapshot.totalUsd, previousUsd);
  if (previousUsd > 0 && comparison.deltaPercent >= thresholds.changeThresholdPercent) {
    reasons.push(
      `Spend is up ${comparison.deltaPercent.toFixed(1)}% day over day, above the ${
        thresholds.changeThresholdPercent
      }% change threshold.`,
    );
  }

  return { alert: reasons.length > 0, reasons };
}

export function topServices(
  byService: Record<string, number>,
  limit = MAX_SERVICES_IN_MESSAGE,
): Array<[string, number]> {
  return Object.entries(byService)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

export interface DailySummaryInput {
  readonly snapshot: DailySnapshot;
  readonly previousUsd: number;
  readonly previousDate: string;
  readonly evaluation: SpendEvaluation;
  readonly timeZone: string;
}

export function buildDailySummaryMessage(input: DailySummaryInput): string {
  const { snapshot, previousUsd, previousDate, evaluation, timeZone } = input;
  const comparison = compareSpend(snapshot.totalUsd, previousUsd);
  const deltaLabel = `${comparison.deltaUsd >= 0 ? '+' : '-'}${formatUsd(Math.abs(comparison.deltaUsd))}`;
  const percentLabel = `${comparison.deltaPercent >= 0 ? '+' : ''}${comparison.deltaPercent.toFixed(1)}%`;

  const lines = [
    '📊 <b>AWS daily cost summary</b>',
    `<b>${snapshot.date}</b> (${escapeHtml(timeZone)})`,
    '',
    `Total: <b>${formatUsd(snapshot.totalUsd)}</b>`,
    `Change vs ${previousDate}: ${deltaLabel} (${percentLabel})`,
    '',
    '<b>Top services</b>',
  ];

  const services = topServices(snapshot.byService);
  if (services.length === 0) {
    lines.push('No service-level usage was reported for this day.');
  } else {
    services.forEach(([service, amount], index) => {
      lines.push(`${index + 1}. ${escapeHtml(service)} — ${formatUsd(amount)}`);
    });
  }

  lines.push('');
  if (evaluation.alert) {
    lines.push('⚠️ <b>Attention</b>');
    for (const reason of evaluation.reasons) {
      lines.push(`• ${escapeHtml(reason)}`);
    }
  } else {
    lines.push('✅ Within the configured thresholds.');
  }

  return truncate(lines.join('\n'));
}

function isoDate(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.slice(0, 10);
}

export function buildAnomalyMessage(detail: AnomalyDetail): string {
  const lines = ['🚨 <b>AWS cost anomaly detected</b>', ''];

  const service = detail.dimensionValue ?? detail.rootCauses?.[0]?.service;
  if (service) {
    lines.push(`Service: <b>${escapeHtml(service)}</b>`);
  }
  if (detail.accountName) {
    lines.push(`Account: ${escapeHtml(detail.accountName)}`);
  }

  const impact = detail.impact;
  if (impact?.totalImpact !== undefined) {
    lines.push(`Estimated impact: <b>${formatUsd(impact.totalImpact)}</b>`);
  }
  if (impact?.totalActualSpend !== undefined && impact?.totalExpectedSpend !== undefined) {
    lines.push(
      `Actual ${formatUsd(impact.totalActualSpend)} vs expected ${formatUsd(impact.totalExpectedSpend)}`,
    );
  }
  if (impact?.totalImpactPercentage !== undefined) {
    lines.push(`Over expected by ${impact.totalImpactPercentage.toFixed(1)}%`);
  }

  const start = isoDate(detail.anomalyStartDate);
  const end = isoDate(detail.anomalyEndDate);
  if (start || end) {
    lines.push(`Window: ${start ?? '?'} → ${end ?? 'ongoing'}`);
  }

  if (detail.monitorName) {
    lines.push(`Monitor: <i>${escapeHtml(detail.monitorName)}</i>`);
  }
  if (detail.anomalyDetailsLink) {
    lines.push('');
    lines.push(`<a href="${escapeHtml(detail.anomalyDetailsLink)}">Open in Cost Management</a>`);
  }

  return truncate(lines.join('\n'));
}
