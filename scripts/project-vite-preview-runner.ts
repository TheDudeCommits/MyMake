import { createRequire } from "node:module";
import * as fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function readArg(flag: string): string {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : null;
  if (!value) {
    throw new Error(`Missing ${flag} argument.`);
  }

  return value;
}

async function main() {
  const projectDir = path.resolve(readArg("--projectDir"));
  const projectId = readArg("--projectId");
  const port = Number(readArg("--port"));

  process.chdir(projectDir);

  const requireFromProject = createRequire(path.join(projectDir, "package.json"));
  const viteEntry = requireFromProject.resolve("vite");
  const viteModule = (await import(pathToFileURL(viteEntry).href)) as {
    createServer: (config: Record<string, unknown>) => Promise<{
      listen: () => Promise<void>;
      resolvedUrls?: { local?: string[] };
    }>;
    loadConfigFromFile: (
      env: Record<string, unknown>,
      configFile?: string,
      configRoot?: string,
    ) => Promise<{ config: Record<string, unknown> } | null>;
    mergeConfig: (
      defaults: Record<string, unknown>,
      overrides: Record<string, unknown>,
    ) => Record<string, unknown>;
  };

  const configEnv = {
    command: "serve",
    mode: "development",
    isSsrBuild: false,
    isPreview: false,
  };

  const configCandidates = [
    "vite.config.ts",
    "vite.config.mjs",
    "vite.config.js",
    "vite.config.cjs",
    "vite.config.mts",
    "vite.config.cts",
  ];
  const configFile = configCandidates.find((candidate) =>
    fs.existsSync(path.join(projectDir, candidate)),
  );

  const loadedConfig = await viteModule.loadConfigFromFile(
    configEnv,
    configFile ? path.join(projectDir, configFile) : undefined,
    projectDir,
  );

  const previewConfig = viteModule.mergeConfig(loadedConfig?.config ?? {}, {
    root: projectDir,
    server: {
      host: "127.0.0.1",
      port,
      strictPort: true,
      hmr: {
        path: `/preview/${projectId}/`,
      },
    },
  });

  const server = await viteModule.createServer(previewConfig);
  await server.listen();

  const localUrl = server.resolvedUrls?.local?.[0] || `http://127.0.0.1:${port}`;
  console.log(`Preview runner ready at ${localUrl}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
