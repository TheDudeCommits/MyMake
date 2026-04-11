import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";

function readArg(flag: string): string {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : null;
  if (!value) {
    throw new Error(`Missing ${flag} argument.`);
  }

  return value;
}

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function safeResolve(rootDir: string, relativePath: string): string | null {
  const resolvedPath = path.resolve(rootDir, relativePath);
  const relativeToRoot = path.relative(rootDir, resolvedPath);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    return null;
  }

  return resolvedPath;
}

function fileExists(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isFile();
  } catch {
    return false;
  }
}

function buildCandidates(urlPath: string): string[] {
  const cleanPath = decodeURIComponent(urlPath).replace(/^\/+/, "");
  if (!cleanPath) {
    return ["index.html"];
  }

  const candidates = [cleanPath];
  if (cleanPath.endsWith("/")) {
    candidates.push(path.join(cleanPath, "index.html"));
    return candidates;
  }

  candidates.push(`${cleanPath}.html`);
  candidates.push(path.join(cleanPath, "index.html"));
  return candidates;
}

async function main() {
  const projectDir = path.resolve(readArg("--projectDir"));
  const port = Number(readArg("--port"));

  const server = createServer((request, response) => {
    const method = request.method || "GET";
    if (!["GET", "HEAD"].includes(method)) {
      response.statusCode = 405;
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.end("Method Not Allowed");
      return;
    }

    const url = new URL(request.url || "/", "http://127.0.0.1");
    const candidates = buildCandidates(url.pathname);

    let targetPath: string | null = null;
    for (const candidate of candidates) {
      const absolutePath = safeResolve(projectDir, candidate);
      if (absolutePath && fileExists(absolutePath)) {
        targetPath = absolutePath;
        break;
      }
    }

    if (!targetPath) {
      response.statusCode = 404;
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.end("404 Not Found");
      return;
    }

    const extension = path.extname(targetPath).toLowerCase();
    response.statusCode = 200;
    response.setHeader("Content-Type", MIME_TYPES[extension] || "application/octet-stream");

    if (method === "HEAD") {
      response.end();
      return;
    }

    const stream = fs.createReadStream(targetPath);
    stream.on("error", () => {
      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
      }
      response.end("Internal Server Error");
    });
    stream.pipe(response);
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`Preview runner ready at http://127.0.0.1:${port}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
