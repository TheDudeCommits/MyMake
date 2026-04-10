import { loadEnvConfig } from "@next/env";
import express, { type NextFunction, type Request, type Response } from "express";
import next from "next";
import { createProxyMiddleware, responseInterceptor } from "http-proxy-middleware";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

import { isAuthorizedCookieValue } from "@/lib/server/auth";
import { getEnv } from "@/lib/server/env";
import {
  buildPreviewBootstrapScript,
  buildPreviewBridgeScript,
} from "@/lib/server/preview-bridge";
import {
  ensurePreviewRunner,
  getActivePreviewProjectId,
  getPreviewTargetUrl,
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
  if (parts[0] !== "preview" || !parts[1]) {
    return null;
  }

  return parts[1];
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

function rewritePreviewPath(pathname: string, projectId: string): string {
  const prefix = `/preview/${projectId}`;
  if (pathname === prefix || pathname === `${prefix}/`) {
    return "/";
  }

  if (pathname.startsWith(`${prefix}/`)) {
    return pathname.slice(prefix.length) || "/";
  }

  return pathname;
}

function isHtmlRequest(request: Request): boolean {
  const acceptHeader = request.headers.accept || "";
  const fetchDestination = request.headers["sec-fetch-dest"];
  return acceptHeader.includes("text/html") || fetchDestination === "document";
}

async function previewAuthGuard(req: Request, res: Response, nextFn: NextFunction) {
  const sessionValue = getCookieValue(req.headers.cookie, "mymake-session");
  if (!(await isAuthorizedCookieValue(sessionValue))) {
    res.status(401).send("Unauthorized preview request.");
    return;
  }

  nextFn();
}

const previewDocumentProxy = createProxyMiddleware<Request, Response>({
  changeOrigin: true,
  selfHandleResponse: true,
  logger: console,
  pathRewrite: (pathname, req) => {
    const projectId = req.mymakeProjectId;
    if (!projectId) {
      return pathname;
    }

    return rewritePreviewPath(pathname, projectId);
  },
  router: async (req) => {
    const projectId = req.mymakeProjectId;
    if (!projectId) {
      throw new Error("Missing preview project id.");
    }

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
    const projectId = req.mymakeProjectId;
    if (!projectId) {
      return pathname;
    }

    return rewritePreviewPath(pathname, projectId);
  },
  router: async (req) => {
    const projectId = req.mymakeProjectId;
    if (!projectId) {
      throw new Error("Missing preview project id.");
    }

    await ensurePreviewRunner(projectId);
    const target = await getPreviewTargetUrl(projectId);
    req.mymakePreviewTarget = target;
    return target;
  },
});

async function dispatchPreviewProxy(req: Request, res: Response, nextFn: NextFunction) {
  if (isHtmlRequest(req)) {
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

  server.use(async (req, res, nextFn) => {
    const refererProjectId = getProjectIdFromReferer(req.headers.referer);
    const fallbackProjectId =
      refererProjectId || (isPreviewAssetPath(req.path) ? getActivePreviewProjectId() : null);

    if (!fallbackProjectId) {
      nextFn();
      return;
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
    const projectId =
      getProjectIdFromPath(req.url) ||
      getProjectIdFromReferer(req.headers.referer) ||
      (isPreviewWebSocketPath(req.url) ? getActivePreviewProjectId() : null);
    if (!projectId) {
      await handleUpgrade(req, socket, head);
      return;
    }

    const sessionValue = getCookieValue(req.headers.cookie, "mymake-session");
    if (!(await isAuthorizedCookieValue(sessionValue))) {
      socket.destroy();
      return;
    }

    req.mymakeProjectId = projectId;
    await ensurePreviewRunner(projectId);
    previewStreamProxy.upgrade(req, socket, head);
  });
});
