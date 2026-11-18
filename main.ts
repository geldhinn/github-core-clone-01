import { createApp } from './app.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';

if (ENV_URL === '') {
  console.error('error: MAKEFUN_ENV_URL is not set');
  process.exit(1);
}

const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 2000;
const MAX_RETRIES = 8;
const REQUEST_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function register(port: number): Promise<void> {
  const url = `${ENV_URL}/register`;
  let delay = BASE_DELAY_MS;
  for (let attempt = 0; ; attempt += 1) {
    let status: number;
    try {
      const result = await fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      status = result.status;
    } catch (error) {
      if (attempt >= MAX_RETRIES) {
        throw error;
      }
      await sleep(delay);
      delay = Math.min(delay * 2, MAX_DELAY_MS);
      continue;
    }
    if (status === 200 || status === 409) {
      console.log(`registered (port ${port}, status ${status})`);
      return;
    }
    if (status === 400 || status === 405) {
      throw new Error(`register rejected by env: HTTP ${status}`);
    }
    if (attempt >= MAX_RETRIES) {
      throw new Error(`register failed: HTTP ${status} after retries`);
    }
    await sleep(delay);
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  }
}

async function waitForDone(): Promise<void> {
  const url = `${ENV_URL}/done`;
  let delay = BASE_DELAY_MS;
  for (;;) {
    let status = 0;
    let body: unknown = null;
    try {
      const result = await fetchJson(url, { method: 'GET' });
      status = result.status;
      body = result.body;
    } catch {
      status = 0;
      body = null;
    }
    const answered = status >= 200 && status < 300;
    if (
      answered &&
      body !== null &&
      typeof body === 'object' &&
      (body as { done?: unknown }).done === true
    ) {
      console.log('env reports done');
      return;
    }
    if (answered) {
      delay = BASE_DELAY_MS;
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    await sleep(delay);
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  }
}

async function main(): Promise<void> {
  const server = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', (error: Error) => {
      reject(error);
    });
    server.once('listening', () => {
      const address = server.address();
      if (
        address !== null &&
        typeof address === 'object' &&
        typeof address.port === 'number'
      ) {
        resolve(address.port);
      } else {
        reject(new Error('server did not bind a TCP port'));
      }
    });
    server.listen(0);
  });
  console.log(`listening on port ${port}`);
  await register(port);
  await waitForDone();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
