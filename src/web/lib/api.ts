/** Cliente da API: manda o cookie de sessão e o token CSRF, e traduz erros para mensagens em português. */

let csrfToken = '';
let onUnauthorized: (() => void) | null = null;

export function setCsrfToken(token: string) {
  csrfToken = token;
}

export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string | null = null,
    public readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

type Body = FormData | Record<string, unknown> | unknown[] | undefined;

export async function api<T>(
  path: string,
  opts: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: Body;
    signal?: AbortSignal;
    keepalive?: boolean;
  } = {},
): Promise<T> {
  const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST');
  const headers: Record<string, string> = { accept: 'application/json' };
  let payload: BodyInit | undefined;
  if (opts.body instanceof FormData) payload = opts.body;
  else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(opts.body);
  }
  if (method !== 'GET') headers['x-csrf-token'] = csrfToken;

  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: payload,
      credentials: 'same-origin',
      signal: opts.signal,
      keepalive: opts.keepalive,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'Sem conexão com o servidor. Confira a internet e tente de novo.', 'offline');
  }
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized?.();
    const d = (typeof data === 'object' && data) || {};
    throw new ApiError(
      res.status,
      (d as { error?: string }).error ?? 'Não foi possível concluir agora. Tente de novo.',
      (d as { code?: string }).code ?? null,
      d as Record<string, unknown>,
    );
  }
  return data as T;
}

/** POST que devolve um arquivo (ex.: dados do titular) e dispara o download no navegador. */
export async function apiDownload(
  path: string,
  body: Record<string, unknown>,
  fileName: string,
): Promise<void> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (d as { error?: string }).error ?? 'Não foi possível gerar o arquivo.');
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'Algo deu errado. Tente de novo.';
}

/** Monta a query string sem campos vazios. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}
