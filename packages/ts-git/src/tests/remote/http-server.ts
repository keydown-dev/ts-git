import { spawn } from 'child_process';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { gitEnv } from './git-helpers.js';

export interface GitHttpServer {
  url: string;
  requests: Array<{ method: string; path: string; auth?: string }>;
  close(): Promise<void>;
}

/**
 * Serve every repository under `projectRoot` over smart HTTP using
 * canonical `git http-backend` (CGI). Pushes are enabled.
 */
export async function startGitHttpServer(
  projectRoot: string,
  home: string,
  options: { basicAuth?: { username: string; password: string } } = {},
): Promise<GitHttpServer> {
  const requests: GitHttpServer['requests'] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const [path, query = ''] = (req.url ?? '/').split('?');
      const auth = req.headers.authorization;
      requests.push({ method: req.method ?? 'GET', path, auth });

      if (options.basicAuth) {
        const expected =
          'Basic ' +
          Buffer.from(
            `${options.basicAuth.username}:${options.basicAuth.password}`,
          ).toString('base64');
        if (auth !== expected) {
          res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"' });
          res.end('auth required');
          return;
        }
      }

      const body = Buffer.concat(chunks);
      const cgi = spawn('git', ['http-backend'], {
        env: {
          ...gitEnv(home),
          GIT_PROJECT_ROOT: projectRoot,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: decodeURIComponent(path),
          QUERY_STRING: query,
          REQUEST_METHOD: req.method ?? 'GET',
          CONTENT_TYPE: req.headers['content-type'] ?? '',
          CONTENT_LENGTH: String(body.length),
          REMOTE_USER: 'tester',
          REMOTE_ADDR: '127.0.0.1',
        },
      });
      const out: Buffer[] = [];
      cgi.stdout.on('data', (c: Buffer) => out.push(c));
      cgi.stderr.on('data', () => undefined);
      cgi.on('close', () => {
        const raw = Buffer.concat(out);
        const sep = raw.indexOf('\r\n\r\n');
        const headerText = raw.subarray(0, sep).toString('utf8');
        const payload = raw.subarray(sep + 4);
        let status = 200;
        const headers: Record<string, string> = {};
        for (const line of headerText.split('\r\n')) {
          const colon = line.indexOf(':');
          if (colon === -1) continue;
          const key = line.slice(0, colon).trim();
          const value = line.slice(colon + 1).trim();
          if (key.toLowerCase() === 'status') status = parseInt(value, 10);
          else headers[key] = value;
        }
        res.writeHead(status, headers);
        res.end(payload);
      });
      cgi.stdin.end(body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
