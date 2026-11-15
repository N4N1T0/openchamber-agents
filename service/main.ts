// The only thing this service exists for: removing an agent file.
//
// The guest file API can read, write, list and stat, but not delete, and a
// service is the only place in an extension that can. It runs with the user's
// full access, so it never takes a path from the panel: it takes a scope, one
// of two folder names and a bare agent name, and builds the path itself.

import http from 'node:http';
import { lstat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN;

/** The two folder names OpenCode reads agents from. */
const FOLDERS = new Set(['agents', 'agent']);
/** No slash, no leading dot, so a name can never walk out of its folder. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type Answer = { status: number; body: Record<string, unknown> };

const bad = (message: string): Answer => ({ status: 400, body: { message } });

const agentPath = (input: Record<string, unknown>): { path: string } | Answer => {
  const { scope, folder, name, directory } = input;
  if (typeof name !== 'string' || !NAME.test(name) || name.includes('..')) {
    return bad('That agent name is not one this extension can remove.');
  }
  if (typeof folder !== 'string' || !FOLDERS.has(folder)) {
    return bad('That is not an agent folder.');
  }
  if (scope === 'global') {
    return { path: join(homedir(), '.config', 'opencode', folder, `${name}.md`) };
  }
  if (scope === 'project') {
    if (typeof directory !== 'string' || directory === '' || !isAbsolute(directory)) {
      return bad('A project agent needs the project folder.');
    }
    return { path: join(resolve(directory), '.opencode', folder, `${name}.md`) };
  }
  return bad('Unknown scope.');
};

const remove = async (body: string): Promise<Answer> => {
  let input: unknown;
  try {
    input = JSON.parse(body || '{}');
  } catch {
    return bad('Could not read the request.');
  }
  if (!input || typeof input !== 'object') return bad('Could not read the request.');

  const target = agentPath(input as Record<string, unknown>);
  if ('status' in target) return target;

  // lstat, not stat: a symlink is not a regular file, so one that points
  // somewhere else is refused instead of followed.
  const info = await lstat(target.path).catch(() => null);
  if (!info) return { status: 404, body: { message: 'That file is already gone.' } };
  if (!info.isFile()) return bad('That path is not an agent file.');

  try {
    await unlink(target.path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: 500, body: { message: `Could not delete the file: ${reason}` } };
  }
  return { status: 200, body: { deleted: true, path: target.path } };
};

const server = http.createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401).end();
    return;
  }
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (path === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
    return;
  }
  if (path !== '/delete' || request.method !== 'POST') {
    response.writeHead(404, { 'Content-Type': 'application/json' }).end('{}');
    return;
  }

  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
    if (body.length > 8192) request.destroy();
  });
  request.on('end', () => {
    remove(body).then(
      (answer) => {
        response
          .writeHead(answer.status, { 'Content-Type': 'application/json' })
          .end(JSON.stringify(answer.body));
      },
      () => {
        response
          .writeHead(500, { 'Content-Type': 'application/json' })
          .end('{"message":"The helper failed."}');
      },
    );
  });
});

server.listen(port, '127.0.0.1');
