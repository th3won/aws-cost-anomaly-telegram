import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

import { DEFAULT_TOKEN_CACHE_TTL_MS, SsmBotTokenProvider } from '../lambda/lib/bot-token';

const TOKEN_PARAM = '/aws-cost-anomaly-telegram/telegram-bot-token';

function fakeClient() {
  return { send: jest.fn() } as unknown as SSMClient & { send: jest.Mock };
}

function providerWith(client: SSMClient, overrides: { ttlMs?: number; now?: () => number } = {}) {
  let clock = 1_700_000_000_000;
  const now = overrides.now ?? (() => clock);
  const provider = new SsmBotTokenProvider({
    parameterName: TOKEN_PARAM,
    client,
    ttlMs: overrides.ttlMs,
    now,
  });
  return {
    provider,
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe('SsmBotTokenProvider', () => {
  test('reads a SecureString parameter with decryption', async () => {
    const client = fakeClient();
    client.send.mockResolvedValue({ Parameter: { Value: 'bot-token' } });
    const { provider } = providerWith(client);

    await expect(provider.getToken()).resolves.toBe('bot-token');

    expect(client.send).toHaveBeenCalledTimes(1);
    const sent = client.send.mock.calls[0][0] as GetParameterCommand;
    expect(sent).toBeInstanceOf(GetParameterCommand);
    expect(sent.input).toEqual({ Name: TOKEN_PARAM, WithDecryption: true });
  });

  test('serves the cached token until the TTL expires', async () => {
    const client = fakeClient();
    client.send.mockResolvedValue({ Parameter: { Value: 'bot-token' } });
    const { provider, advance } = providerWith(client);

    await provider.getToken();
    advance(DEFAULT_TOKEN_CACHE_TTL_MS - 1);

    await expect(provider.getToken()).resolves.toBe('bot-token');
    expect(client.send).toHaveBeenCalledTimes(1);

    advance(1);
    await provider.getToken();
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  test('picks up a rotated value after the TTL without a redeploy', async () => {
    const client = fakeClient();
    client.send
      .mockResolvedValueOnce({ Parameter: { Value: 'old-token' } })
      .mockResolvedValueOnce({ Parameter: { Value: 'new-token' } });
    const { provider, advance } = providerWith(client, { ttlMs: 60_000 });

    await expect(provider.getToken()).resolves.toBe('old-token');
    advance(60_000);
    await expect(provider.getToken()).resolves.toBe('new-token');
  });

  test('invalidate() forces the next read', async () => {
    const client = fakeClient();
    client.send.mockResolvedValue({ Parameter: { Value: 'bot-token' } });
    const { provider } = providerWith(client);

    await provider.getToken();
    provider.invalidate();
    await provider.getToken();

    expect(client.send).toHaveBeenCalledTimes(2);
  });

  test('shares one SSM request between concurrent callers', async () => {
    const client = fakeClient();
    let resolveSend: (value: unknown) => void = () => undefined;
    client.send.mockReturnValue(
      new Promise((resolve) => {
        resolveSend = resolve;
      }),
    );
    const { provider } = providerWith(client);

    const first = provider.getToken();
    const second = provider.getToken();
    resolveSend({ Parameter: { Value: 'bot-token' } });

    await expect(Promise.all([first, second])).resolves.toEqual(['bot-token', 'bot-token']);
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  test('explains how to create a missing parameter', async () => {
    const client = fakeClient();
    client.send.mockRejectedValue(
      Object.assign(new Error('Parameter not found.'), { name: 'ParameterNotFound' }),
    );
    const { provider } = providerWith(client);

    await expect(provider.getToken()).rejects.toThrow(/put-parameter --name \/aws-cost-anomaly-telegram/);
  });

  test('explains an IAM or KMS problem on access denied', async () => {
    const client = fakeClient();
    client.send.mockRejectedValue(
      Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' }),
    );
    const { provider } = providerWith(client);

    await expect(provider.getToken()).rejects.toThrow(/ssm:GetParameter.*kms:Decrypt/);
  });

  test('rejects an empty parameter value', async () => {
    const client = fakeClient();
    client.send.mockResolvedValue({ Parameter: { Value: '   ' } });
    const { provider } = providerWith(client);

    await expect(provider.getToken()).rejects.toThrow(/is empty/);
  });

  test('keeps the original error as the cause', async () => {
    const client = fakeClient();
    const failure = Object.assign(new Error('boom'), { name: 'ThrottlingException' });
    client.send.mockRejectedValue(failure);
    const { provider } = providerWith(client);

    await expect(provider.getToken()).rejects.toMatchObject({
      message: expect.stringContaining(`Failed to read SSM parameter ${TOKEN_PARAM}`),
      cause: failure,
    });
  });

  test('requires a fully qualified parameter name', () => {
    expect(
      () => new SsmBotTokenProvider({ parameterName: 'telegram-bot-token' }),
    ).toThrow(/must start with "\/"/);
  });

  test('rejects a negative TTL', () => {
    expect(
      () => new SsmBotTokenProvider({ parameterName: TOKEN_PARAM, ttlMs: -1 }),
    ).toThrow(/must not be negative/);
  });
});
