export interface ApiResponse {
  status: number;
  data: Record<string, unknown>;
}

export class DemoError extends Error {}

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly key: string | undefined
  ) {}

  async request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    options?: { auth?: boolean; keyOverride?: string }
  ): Promise<ApiResponse> {
    const useAuth = options?.auth !== false;
    const authKey = options?.keyOverride ?? this.key;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (useAuth && authKey) {
      headers.Authorization = `Bearer ${authKey}`;
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new DemoError(`Request ${method} ${path} failed: ${(err as Error).message}`);
    }

    let data: Record<string, unknown> = {};
    const text = await response.text();
    if (text) {
      try {
        data = JSON.parse(text) as Record<string, unknown>;
      } catch {
        data = { raw: text.slice(0, 200) };
      }
    }
    return { status: response.status, data };
  }
}

/** Public identification only — the prefix is not secret; the suffix is. */
export function maskKey(key: string): string {
  return `${key.split('.')[0]}.***`;
}

export function errCode(res: ApiResponse): string {
  const error = res.data.error as { code?: string } | undefined;
  return error?.code ?? '<none>';
}
