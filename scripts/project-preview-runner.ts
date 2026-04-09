import { createRequire } from "node:module";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import path from "node:path";

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
  const port = Number(readArg("--port"));

  const requireFromProject = createRequire(path.join(projectDir, "package.json"));
  const nextModule = requireFromProject("next");
  const nextFactory = nextModule.default ?? nextModule;
  const configPath = requireFromProject.resolve("next/dist/server/config");
  const constantsPath = requireFromProject.resolve("next/dist/shared/lib/constants");
  const { default: loadConfig } = (await import(pathToFileURL(configPath).href)) as {
    default: (
      phase: string,
      dir: string,
      options?: { silent?: boolean },
    ) => Promise<Record<string, unknown>>;
  };
  const { PHASE_DEVELOPMENT_SERVER } = (await import(
    pathToFileURL(constantsPath).href
  )) as {
    PHASE_DEVELOPMENT_SERVER: string;
  };

  const userConfig = await loadConfig(PHASE_DEVELOPMENT_SERVER, projectDir, { silent: true });
  const app = nextFactory({
    dev: true,
    dir: projectDir,
    hostname: "127.0.0.1",
    port,
    conf: userConfig,
  });

  const handle = app.getRequestHandler();
  await app.prepare();

  createServer((req, res) => handle(req, res)).listen(port, "127.0.0.1", () => {
    console.log(`Preview runner ready at http://127.0.0.1:${port}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
