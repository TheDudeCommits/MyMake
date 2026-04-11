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
  const importedViteModule = (await import(pathToFileURL(viteEntry).href)) as {
    default?: {
      createServer?: (config: Record<string, unknown>) => Promise<{
        listen: () => Promise<void>;
        resolvedUrls?: { local?: string[] };
      }>;
    };
    createServer?: (config: Record<string, unknown>) => Promise<{
      listen: () => Promise<void>;
      resolvedUrls?: { local?: string[] };
    }>;
  };
  const createServer =
    importedViteModule.createServer ?? importedViteModule.default?.createServer;

  if (!createServer) {
    throw new Error("Could not access Vite's createServer API for this project.");
  }

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
  const previewConfig: Record<string, unknown> = {
    root: projectDir,
    mode: "development",
    configFile: configFile ? path.join(projectDir, configFile) : undefined,
    server: {
      host: "127.0.0.1",
      port,
      strictPort: true,
      hmr: {
        path: `/preview/${projectId}/`,
      },
    },
  };

  const server = await createServer(previewConfig);
  await server.listen();

  const localUrl = server.resolvedUrls?.local?.[0] || `http://127.0.0.1:${port}`;
  console.log(`Preview runner ready at ${localUrl}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
