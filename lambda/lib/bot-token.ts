import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

/**
 * How long a token read from Parameter Store is reused inside a warm execution
 * environment. Five minutes keeps the number of SSM calls negligible (the
 * function runs once or twice a day) while still letting a rotated token take
 * effect without a redeploy.
 */
export const DEFAULT_TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;

/** Supplies the Telegram bot token at call time. */
export interface BotTokenSource {
  getToken(): Promise<string>;
}

export interface SsmBotTokenProviderOptions {
  /** Full parameter name, for example `/aws-cost-anomaly-telegram/telegram-bot-token`. */
  readonly parameterName: string;
  /** Injected for tests; a default client is created otherwise. */
  readonly client?: SSMClient;
  /** Cache lifetime. Defaults to {@link DEFAULT_TOKEN_CACHE_TTL_MS}. */
  readonly ttlMs?: number;
  /** Clock, injectable so tests can travel through the TTL. */
  readonly now?: () => number;
}

/**
 * Reads the Telegram bot token from an SSM Parameter Store `SecureString`.
 *
 * The value never reaches the Lambda configuration or the CloudFormation
 * template: the deployment only carries the parameter name, and the token is
 * decrypted at runtime with `WithDecryption: true`. The resolved value is
 * cached for `ttlMs` so a warm invocation does not call SSM again, and a
 * failed or empty lookup is never cached.
 */
export class SsmBotTokenProvider implements BotTokenSource {
  public readonly parameterName: string;

  private readonly client: SSMClient;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private cached?: { readonly value: string; readonly expiresAt: number };
  private pending?: Promise<string>;

  constructor(options: SsmBotTokenProviderOptions) {
    if (!options.parameterName.startsWith('/')) {
      throw new Error(
        `SSM parameter name must start with "/", got "${options.parameterName}".`,
      );
    }
    if (options.ttlMs !== undefined && options.ttlMs < 0) {
      throw new Error(`ttlMs must not be negative, got ${options.ttlMs}.`);
    }

    this.parameterName = options.parameterName;
    this.client = options.client ?? new SSMClient({});
    this.ttlMs = options.ttlMs ?? DEFAULT_TOKEN_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  public async getToken(): Promise<string> {
    const now = this.now();
    if (this.cached && now < this.cached.expiresAt) {
      return this.cached.value;
    }

    // Single flight: concurrent callers in the same execution environment share
    // one SSM request instead of one each.
    this.pending ??= this.fetchToken(now);
    try {
      return await this.pending;
    } finally {
      this.pending = undefined;
    }
  }

  /** Drops the cached token, for example after the parameter was rotated. */
  public invalidate(): void {
    this.cached = undefined;
  }

  private async fetchToken(now: number): Promise<string> {
    let value: string | undefined;

    try {
      const response = await this.client.send(
        new GetParameterCommand({ Name: this.parameterName, WithDecryption: true }),
      );
      value = response.Parameter?.Value;
    } catch (error) {
      throw new Error(this.describeFailure(error), { cause: error });
    }

    if (value === undefined || value.trim() === '') {
      throw new Error(
        `SSM parameter ${this.parameterName} is empty. Store the Telegram bot token with: ` +
          `aws ssm put-parameter --name ${this.parameterName} --type SecureString --value <bot-token>`,
      );
    }

    this.cached = { value, expiresAt: now + this.ttlMs };
    return value;
  }

  private describeFailure(error: unknown): string {
    const name = (error as { name?: string } | undefined)?.name ?? 'UnknownError';
    const message = error instanceof Error ? error.message : String(error);

    if (name === 'ParameterNotFound' || /parameter.*not found/i.test(message)) {
      return (
        `SSM parameter ${this.parameterName} was not found. Create it before the first run: ` +
        `aws ssm put-parameter --name ${this.parameterName} --type SecureString --value <bot-token>`
      );
    }
    if (name === 'AccessDeniedException' || name === 'AccessDenied') {
      return (
        `Access denied reading SSM parameter ${this.parameterName}. The function role needs ` +
        'ssm:GetParameter on the parameter ARN and kms:Decrypt on its key.'
      );
    }
    return `Failed to read SSM parameter ${this.parameterName}: ${message}`;
  }
}
