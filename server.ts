import { loadEnvConfig } from "@next/env";
import express, { type NextFunction, type Request, type Response } from "express";
import next from "next";
import { createProxyMiddleware, responseInterceptor } from "http-proxy-middleware";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

import { doesUserOwnProject, readSessionCookieValue } from "@/lib/server/auth";
import { getEnv } from "@/lib/server/env";
import {
  buildPreviewBootstrapScript,
  buildPreviewBridgeScript,
} from "@/lib/server/preview-bridge";
import {
  ensurePreviewRunner,
  getActivePreviewProjectId,
  getPreviewRunnerInfo,
  getPreviewTargetUrl,
  warmPreviewRunner,
} from "@/lib/server/preview-manager";

declare module "http" {
  interface IncomingMessage {
    mymakePreviewTarget?: string;
    mymakeProjectId?: string;
  }
}

loadEnvConfig(process.cwd());

const dev = process.env.NODE_ENV !== "production";
const app = next({ dev, hostname: "0.0.0.0", port: getEnv().port });
const handle = app.getRequestHandler();
const handleUpgrade = app.getUpgradeHandler();

function getProjectIdFromPath(pathname = ""): string | null {
  const parts = pathname.split("/").filter(Boolean);
  if (!["preview", "public-preview"].includes(parts[0]) || !parts[1]) {
    return null;
  }

  return parts[1];
}

function getProjectIdFromParams(
  params: Record<string, string | string[] | undefined> | undefined,
): string | null {
  if (!params?.projectId) {
    return null;
  }

  return Array.isArray(params.projectId) ? params.projectId[0] || null : params.projectId;
}

function isPublicPreviewPath(pathname = ""): boolean {
  return pathname.split("/").filter(Boolean)[0] === "public-preview";
}

function isPublicPreviewLocation(value: string | string[] | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = Array.isArray(value) ? value[0] : value;
  try {
    return isPublicPreviewPath(new URL(normalized).pathname);
  } catch {
    return isPublicPreviewPath(normalized);
  }
}

function getProjectIdFromReferer(referer: string | string[] | undefined): string | null {
  if (!referer) {
    return null;
  }

  const normalized = Array.isArray(referer) ? referer[0] : referer;
  try {
    const url = new URL(normalized);
    return getProjectIdFromPath(url.pathname);
  } catch {
    return null;
  }
}

function isPreviewAssetPath(pathname = ""): boolean {
  return (
    pathname === "/vite.svg" ||
    pathname === "/@vite/client" ||
    pathname === "/@react-refresh" ||
    pathname.startsWith("/src/") ||
    pathname.startsWith("/assets/") ||
    pathname.startsWith("/node_modules/") ||
    pathname.startsWith("/@id/") ||
    pathname.startsWith("/@fs/")
  );
}

function isPreviewWebSocketPath(url = ""): boolean {
  return url.startsWith("/?token=");
}

function resolvePreviewProjectId(request: {
  mymakeProjectId?: string;
  url?: string;
  path?: string;
  params?: Record<string, string | string[] | undefined>;
  headers: {
    referer?: string | string[];
  };
}): string | null {
  return (
    request.mymakeProjectId ||
    getProjectIdFromParams(request.params) ||
    getProjectIdFromPath(request.path || request.url || "") ||
    getProjectIdFromReferer(request.headers.referer) ||
    (isPreviewWebSocketPath(request.url || "") ? getActivePreviewProjectId() : null)
  );
}

function getCookieValue(
  cookieHeader: string | string[] | undefined,
  name: string,
): string | null {
  if (!cookieHeader) {
    return null;
  }

  const normalizedHeader = Array.isArray(cookieHeader) ? cookieHeader.join(";") : cookieHeader;
  const cookies = normalizedHeader.split(";").map((value) => value.trim());
  for (const cookie of cookies) {
    const [cookieName, ...rest] = cookie.split("=");
    if (cookieName === name) {
      return decodeURIComponent(rest.join("="));
    }
  }

  return null;
}

function setNoStoreHeaders(res: Response): void {
  res.setHeader("Cache-Control", "no-store, no-cache, max-age=0, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}

function injectPreviewBridge(html: string, projectId: string): string {
  const bootstrap = `<script>${buildPreviewBootstrapScript(projectId)}</script>`;
  const bridge = `<script>${buildPreviewBridgeScript(projectId)}</script>`;
  const withBootstrap = html.includes("</head>")
    ? html.replace("</head>", `${bootstrap}</head>`)
    : `${bootstrap}${html}`;

  if (withBootstrap.includes("</body>")) {
    return withBootstrap.replace("</body>", `${bridge}</body>`);
  }

  return `${withBootstrap}${bridge}`;
}

function buildPreviewLoadingHtml(projectId: string, state: "starting" | "error"): string {
  const headline = state === "error" ? "Reconnecting preview..." : "Starting preview...";
  const body =
    state === "error"
      ? "The last preview session dropped. MyMake is restarting the runner and will retry automatically."
      : "MyMake is warming the uploaded app in the background. This frame will reconnect automatically as soon as the runner is ready.";

  return `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>
          :root {
            color-scheme: dark;
          }

          html, body {
            margin: 0;
            min-height: 100%;
            background:
              radial-gradient(circle at top, rgba(97, 103, 255, 0.18), transparent 26%),
              #0f1117;
            color: #eef2ff;
            font-family: Inter, ui-sans-serif, system-ui, sans-serif;
          }

          body {
            display: grid;
            place-items: center;
            padding: 24px;
          }

          .card {
            width: min(420px, 100%);
            border-radius: 24px;
            border: 1px solid rgba(255, 255, 255, 0.08);
            background: rgba(23, 25, 33, 0.94);
            box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
            padding: 24px 26px;
          }

          .eyebrow {
            font-size: 11px;
            letter-spacing: 0.22em;
            text-transform: uppercase;
            color: #99a2bd;
          }

          h1 {
            margin: 14px 0 10px;
            font-size: 20px;
            line-height: 1.2;
          }

          p {
            margin: 0;
            line-height: 1.7;
            color: #b8c0d9;
          }

          .loader {
            margin-top: 18px;
            display: flex;
            align-items: center;
            gap: 10px;
            color: #dbe4ff;
            font-size: 13px;
          }

          .dot {
            width: 9px;
            height: 9px;
            border-radius: 999px;
            background: #6b70ff;
            box-shadow: 0 0 18px rgba(107, 112, 255, 0.55);
            animation: pulse 0.9s ease-in-out infinite alternate;
          }

          @keyframes pulse {
            from { transform: scale(0.9); opacity: 0.7; }
            to { transform: scale(1.15); opacity: 1; }
          }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="eyebrow">MyMake preview</div>
          <h1>${headline}</h1>
          <p>${body}</p>
          <div class="loader"><span class="dot"></span> Project: ${projectId}</div>
        </div>
        <script>
          window.setTimeout(() => {
            const url = new URL(window.location.href);
            url.searchParams.set("__mymake_reload", String(Date.now()));
            window.location.replace(url.toString());
          }, 900);
        </script>
      </body>
    </html>`;
}

function rewritePreviewPath(pathname: string, projectId: string): string {
  const prefix = `/preview/${projectId}`;
  const publicPrefix = `/public-preview/${projectId}`;

  if (
    pathname === prefix ||
    pathname === `${prefix}/` ||
    pathname === publicPrefix ||
    pathname === `${publicPrefix}/`
  ) {
    return "/";
  }

  if (pathname.startsWith(`${prefix}/`)) {
    return pathname.slice(prefix.length) || "/";
  }

  if (pathname.startsWith(`${publicPrefix}/`)) {
    return pathname.slice(publicPrefix.length) || "/";
  }

  return pathname;
}

function isHtmlRequest(request: Request): boolean {
  const acceptHeader = request.headers.accept || "";
  const fetchDestination = request.headers["sec-fetch-dest"];
  return acceptHeader.includes("text/html") || fetchDestination === "document";
}

async function previewAuthGuard(req: Request, res: Response, nextFn: NextFunction) {
  const session = readSessionCookieValue(getCookieValue(req.headers.cookie, "mymake-session"));
  const projectId = resolvePreviewProjectId(req);
  setNoStoreHeaders(res);

  if (!session) {
    res.status(401).send("Unauthorized preview request.");
    return;
  }

  if (!projectId || !doesUserOwnProject(projectId, session.userId)) {
    res.status(403).send("You do not have access to this preview.");
    return;
  }

  req.mymakeProjectId = projectId;
  nextFn();
}

async function ensurePreviewDocumentRunner(
  projectId: string,
  timeoutMs = 8_000,
): Promise<boolean> {
  let timeout: NodeJS.Timeout | null = null;

  try {
    await Promise.race([
      ensurePreviewRunner(projectId),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Preview document startup timed out.")),
          timeoutMs,
        );
      }),
    ]);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message === "Preview document startup timed out.") {
      return false;
    }

    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

const previewDocumentProxy = createProxyMiddleware<Request, Response>({
  changeOrigin: true,
  selfHandleResponse: true,
  logger: console,
  pathRewrite: (pathname, req) => {
    const projectId = resolvePreviewProjectId(req);
    if (!projectId) {
      return pathname;
    }

    req.mymakeProjectId = projectId;
    return rewritePreviewPath(pathname, projectId);
  },
  router: async (req) => {
    const projectId = resolvePreviewProjectId(req);
    if (!projectId) {
      throw new Error("Missing preview project id.");
    }

    req.mymakeProjectId = projectId;
    await ensurePreviewRunner(projectId);
    const target = await getPreviewTargetUrl(projectId);
    req.mymakePreviewTarget = target;
    return target;
  },
  on: {
    proxyRes: responseInterceptor(async (buffer, proxyRes, req) => {
      const projectId = req.mymakeProjectId;
      const contentType = String(proxyRes.headers["content-type"] || "");

      if (!projectId || !contentType.includes("text/html")) {
        return buffer;
      }

      return injectPreviewBridge(buffer.toString("utf8"), projectId);
    }),
    error: (error, _req, res) => {
      if ("status" in res) {
        (res as Response)
          .status(503)
          .send(`<!doctype html>
            <html>
              <head>
                <meta charset="utf-8" />
                <meta http-equiv="refresh" content="1" />
                <style>
                  body {
                    margin: 0;
                    min-height: 100vh;
                    display: grid;
                    place-items: center;
                    background: #070b12;
                    color: #dbeafe;
                    font-family: ui-sans-serif, system-ui, sans-serif;
                  }
                  .card {
                    max-width: 420px;
                    padding: 24px 28px;
                    border-radius: 24px;
                    border: 1px solid rgba(255,255,255,0.08);
                    background: rgba(255,255,255,0.04);
                    text-align: center;
                  }
                </style>
              </head>
              <body>
                <div class="card">
                  <h1 style="margin: 0 0 12px; font-size: 18px;">Starting preview…</h1>
                  <p style="margin: 0; line-height: 1.7; color: #94a3b8;">
                    MyMake is warming up the uploaded frontend preview runner. This frame will refresh automatically.
                  </p>
                </div>
              </body>
            </html>`);
      }
    },
  },
});

const previewStreamProxy = createProxyMiddleware<Request, Response>({
  changeOrigin: true,
  logger: console,
  ws: true,
  pathRewrite: (pathname, req) => {
    const projectId = resolvePreviewProjectId(req);
    if (!projectId) {
      return pathname;
    }

    req.mymakeProjectId = projectId;
    return rewritePreviewPath(pathname, projectId);
  },
  router: async (req) => {
    const projectId = resolvePreviewProjectId(req);
    if (!projectId) {
      throw new Error("Missing preview project id.");
    }

    req.mymakeProjectId = projectId;
    await ensurePreviewRunner(projectId);
    const target = await getPreviewTargetUrl(projectId);
    req.mymakePreviewTarget = target;
    return target;
  },
});

async function dispatchPreviewProxy(req: Request, res: Response, nextFn: NextFunction) {
  const projectId = req.mymakeProjectId;
  if (!projectId) {
    nextFn();
    return;
  }

  res.setHeader("Cache-Control", "no-store, no-cache, max-age=0, must-revalidate");

  if (isHtmlRequest(req)) {
    let runner = getPreviewRunnerInfo(projectId);

    if (!runner || runner.status !== "ready") {
      try {
        const isReady = await ensurePreviewDocumentRunner(projectId);
        runner = getPreviewRunnerInfo(projectId);
        if (!isReady || !runner || runner.status !== "ready") {
          warmPreviewRunner(projectId);
          res
            .status(runner?.status === "error" ? 503 : 202)
            .send(
              buildPreviewLoadingHtml(
                projectId,
                runner?.status === "error" ? "error" : "starting",
              ),
            );
          return;
        }
      } catch (error) {
        warmPreviewRunner(projectId);
        res
          .status(503)
          .send(buildPreviewLoadingHtml(projectId, "error"));
        process.stderr.write(
          `[preview:${projectId}] document proxy startup failed: ${
            error instanceof Error ? error.stack || error.message : String(error)
          }\n`,
        );
        return;
      }
    }

    await previewDocumentProxy(req, res, nextFn);
    return;
  }

  await previewStreamProxy(req, res, nextFn);
}

app.prepare().then(() => {
  const server = express();

  server.disable("x-powered-by");

  server.use("/preview/:projectId", previewAuthGuard, async (req, _res, nextFn) => {
    req.mymakeProjectId = Array.isArray(req.params.projectId)
      ? req.params.projectId[0]
      : req.params.projectId;
    nextFn();
  });

  server.use("/preview/:projectId", dispatchPreviewProxy);

  server.use("/public-preview/:projectId", async (req, _res, nextFn) => {
    req.mymakeProjectId = Array.isArray(req.params.projectId)
      ? req.params.projectId[0]
      : req.params.projectId;
    nextFn();
  });

  server.use("/public-preview/:projectId", dispatchPreviewProxy);

  server.use(async (req, res, nextFn) => {
    const refererProjectId = getProjectIdFromReferer(req.headers.referer);
    const fallbackProjectId =
      refererProjectId || (isPreviewAssetPath(req.path) ? getActivePreviewProjectId() : null);

    if (!fallbackProjectId) {
      nextFn();
      return;
    }

    if (!isPublicPreviewLocation(req.headers.referer)) {
      const session = readSessionCookieValue(getCookieValue(req.headers.cookie, "mymake-session"));
      setNoStoreHeaders(res);
      if (!session) {
        res.status(401).send("Unauthorized preview request.");
        return;
      }

      if (!doesUserOwnProject(fallbackProjectId, session.userId)) {
        res.status(403).send("You do not have access to this preview.");
        return;
      }
    }

    req.mymakeProjectId = fallbackProjectId;
    await dispatchPreviewProxy(req, res, nextFn);
  });

  server.use(async (req, res) => {
    await handle(req, res);
  });

  const httpServer = server.listen(getEnv().port, () => {
    console.log(`MyMake listening on http://0.0.0.0:${getEnv().port}`);
  });

  httpServer.on("upgrade", async (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const projectId = resolvePreviewProjectId(req as IncomingMessage & {
      mymakeProjectId?: string;
      path?: string;
    });
    if (!projectId) {
      if (isPreviewWebSocketPath(req.url || "")) {
        socket.destroy();
        return;
      }

      await handleUpgrade(req, socket, head);
      return;
    }

    const session = readSessionCookieValue(getCookieValue(req.headers.cookie, "mymake-session"));
    const isPublicRequest =
      isPublicPreviewPath(req.url || "") || isPublicPreviewLocation(req.headers.referer);
    const sessionUserId = session?.userId ?? null;
    if (!isPublicRequest && !session) {
      socket.destroy();
      return;
    }

    if (!isPublicRequest && (!projectId || !sessionUserId || !doesUserOwnProject(projectId, sessionUserId))) {
      socket.destroy();
      return;
    }

    req.mymakeProjectId = projectId;
    await ensurePreviewRunner(projectId);
    previewStreamProxy.upgrade(req, socket, head);
  });
});
