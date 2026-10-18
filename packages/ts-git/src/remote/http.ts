/**
 * Minimal HTTP abstraction for the smart HTTP transport.
 *
 * The default client uses the global `fetch`, so it works in browsers, Deno,
 * Bun, Node 18+ and Tauri webviews. Supply your own HttpClient to route
 * requests through a native layer or add retries.
 */

export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: Uint8Array;
}

export interface HttpResponse {
  url: string;
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

export interface GitAuth {
  username?: string;
  password?: string;
  /** Extra headers, e.g. `{ Authorization: 'Bearer <token>' }`. */
  headers?: Record<string, string>;
}

/**
 * Called when the server answers 401. Return credentials to retry with, or
 * nothing to give up.
 */
export type AuthCallback = (
  url: string,
  previous: GitAuth | undefined,
) => GitAuth | void | Promise<GitAuth | void>;

/** Called when credentials were rejected (401/403 after onAuth). */
export type AuthFailureCallback = (
  url: string,
  auth: GitAuth,
) => void | Promise<void>;

export function createFetchHttpClient(
  fetchImpl: typeof fetch = globalThis.fetch,
): HttpClient {
  if (!fetchImpl) {
    throw new Error(
      'No global fetch available; pass an HttpClient via the `http` option',
    );
  }
  return {
    async request(req) {
      const res = await fetchImpl(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body as BodyInit | undefined,
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      return {
        url: res.url || req.url,
        statusCode: res.status,
        statusMessage: res.statusText,
        headers,
        body: new Uint8Array(await res.arrayBuffer()),
      };
    },
  };
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function authHeaders(auth: GitAuth | undefined): Record<string, string> {
  if (!auth) return {};
  const headers: Record<string, string> = { ...(auth.headers ?? {}) };
  if (auth.username !== undefined || auth.password !== undefined) {
    headers['Authorization'] =
      `Basic ${base64(`${auth.username ?? ''}:${auth.password ?? ''}`)}`;
  }
  return headers;
}

/**
 * Split credentials embedded in a URL (https://user:token@host/repo.git)
 * from the URL itself.
 */
export function extractUrlAuth(url: string): { url: string; auth?: GitAuth } {
  const match = url.match(/^(https?:\/\/)([^@/]+)@(.*)$/);
  if (!match) return { url };
  const [, scheme, userinfo, rest] = match;
  const colon = userinfo.indexOf(':');
  const username = decodeURIComponent(
    colon === -1 ? userinfo : userinfo.slice(0, colon),
  );
  const password =
    colon === -1 ? undefined : decodeURIComponent(userinfo.slice(colon + 1));
  return { url: `${scheme}${rest}`, auth: { username, password } };
}

/**
 * Route a URL through a CORS proxy using the same convention as
 * isomorphic-git (`https://proxy.example/github.com/user/repo.git`).
 */
export function corsProxify(corsProxy: string, url: string): string {
  const base = corsProxy.endsWith('/') ? corsProxy : `${corsProxy}/`;
  return `${base}${url.replace(/^https?:\/\//, '')}`;
}
