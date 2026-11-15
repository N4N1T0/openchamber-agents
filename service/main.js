// service/main.ts
import http from "node:http";
import { lstat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN;
var FOLDERS = new Set(["agents", "agent"]);
var NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
var bad = (message) => ({ status: 400, body: { message } });
var agentPath = (input) => {
  const { scope, folder, name, directory } = input;
  if (typeof name !== "string" || !NAME.test(name) || name.includes("..")) {
    return bad("That agent name is not one this extension can remove.");
  }
  if (typeof folder !== "string" || !FOLDERS.has(folder)) {
    return bad("That is not an agent folder.");
  }
  if (scope === "global") {
    return { path: join(homedir(), ".config", "opencode", folder, `${name}.md`) };
  }
  if (scope === "project") {
    if (typeof directory !== "string" || directory === "" || !isAbsolute(directory)) {
      return bad("A project agent needs the project folder.");
    }
    return { path: join(resolve(directory), ".opencode", folder, `${name}.md`) };
  }
  return bad("Unknown scope.");
};
var remove = async (body) => {
  let input;
  try {
    input = JSON.parse(body || "{}");
  } catch {
    return bad("Could not read the request.");
  }
  if (!input || typeof input !== "object")
    return bad("Could not read the request.");
  const target = agentPath(input);
  if ("status" in target)
    return target;
  const info = await lstat(target.path).catch(() => null);
  if (!info)
    return { status: 404, body: { message: "That file is already gone." } };
  if (!info.isFile())
    return bad("That path is not an agent file.");
  try {
    await unlink(target.path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: 500, body: { message: `Could not delete the file: ${reason}` } };
  }
  return { status: 200, body: { deleted: true, path: target.path } };
};
var server = http.createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401).end();
    return;
  }
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (path === "/health") {
    response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    return;
  }
  if (path !== "/delete" || request.method !== "POST") {
    response.writeHead(404, { "Content-Type": "application/json" }).end("{}");
    return;
  }
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
    if (body.length > 8192)
      request.destroy();
  });
  request.on("end", () => {
    remove(body).then((answer) => {
      response.writeHead(answer.status, { "Content-Type": "application/json" }).end(JSON.stringify(answer.body));
    }, () => {
      response.writeHead(500, { "Content-Type": "application/json" }).end('{"message":"The helper failed."}');
    });
  });
});
server.listen(port, "127.0.0.1");
