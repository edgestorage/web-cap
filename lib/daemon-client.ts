import { delay, formatError, startDetachedDaemon } from './daemon-bootstrap';
import { WebCapRpcClient } from './server/app-rpc';
import { resolveWebCapBuildId } from './server/build-id';

export async function connectToDaemon(): Promise<WebCapRpcClient> {
  const expectedBuildId = await resolveWebCapBuildId();
  const client = createClient(expectedBuildId);
  const existing = await tryStartClient(client);
  if (existing.ok) {
    return client;
  }

  startDetachedDaemon();

  const retryingClient = createClient(expectedBuildId);
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < 5_000) {
    const result = await tryStartClient(retryingClient);
    if (result.ok) {
      return retryingClient;
    }

    lastError = result.error;
    await delay(100);
  }

  throw new Error(
    `WEB_CAP runtime daemon did not become ready within 5000ms. Last error: ${formatError(lastError)}`,
  );
}

function createClient(expectedBuildId: string): WebCapRpcClient {
  return new WebCapRpcClient(undefined, undefined, {
    autoStartDaemon: true,
    expectedBuildId,
    startDaemon: startDetachedDaemon,
  });
}

async function tryStartClient(
  client: WebCapRpcClient,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  try {
    await client.start();
    return { ok: true };
  } catch (error) {
    await client.close().catch(() => undefined);
    return { ok: false, error };
  }
}
