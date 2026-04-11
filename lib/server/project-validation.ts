import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

import { ensureStaticEditableOverridesSupport } from "@/lib/server/static-overrides";
import type { PackageManager, ProjectRuntime } from "@/lib/types";

interface ProjectManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  scripts?: Record<string, string>;
  workspaces?: unknown;
}

interface ValidationResult {
  ok: boolean;
  packageManager: PackageManager;
  runtime?: ProjectRuntime;
  reason?: string;
}

const DISALLOWED_DEPENDENCIES = [
  "@neondatabase/serverless",
  "drizzle-orm",
  "ioredis",
  "mongodb",
  "mongoose",
  "mysql",
  "mysql2",
  "pg",
  "prisma",
  "redis",
  "sqlite3",
  "socket.io",
  "typeorm",
];

const TEXT_SOURCE_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".mdx",
  ".mjs",
  ".ts",
  ".tsx",
]);

const ROUTER_PREVIEW_BASENAME_HELPER = "__MYMAKE_PREVIEW_BASENAME__";

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(rootDir: string, currentDir = rootDir): Promise<string[]> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(rootDir, absolutePath)));
      continue;
    }

    files.push(path.relative(rootDir, absolutePath));
  }

  return files;
}

async function readManifest(projectDir: string): Promise<ProjectManifest | null> {
  const packageJsonPath = path.join(projectDir, "package.json");
  if (!(await pathExists(packageJsonPath))) {
    return null;
  }

  return JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as ProjectManifest;
}

function collectManifestDependencies(manifest: ProjectManifest): Record<string, string> {
  return {
    ...(manifest.dependencies || {}),
    ...(manifest.devDependencies || {}),
    ...(manifest.peerDependencies || {}),
  };
}

function hasJsLikeExtension(filePath: string): boolean {
  return [".js", ".jsx", ".ts", ".tsx"].includes(path.extname(filePath).toLowerCase());
}

function scriptKindForPath(filePath: string): ts.ScriptKind {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".tsx") {
    return ts.ScriptKind.TSX;
  }

  if (extension === ".jsx") {
    return ts.ScriptKind.JSX;
  }

  if (extension === ".js" || extension === ".mjs") {
    return ts.ScriptKind.JS;
  }

  return ts.ScriptKind.TS;
}

function isIdentifierNamed(
  node: ts.Node | undefined,
  expected: string,
): node is ts.Identifier {
  return Boolean(node && ts.isIdentifier(node) && node.text === expected);
}

function isBrowserRouterTagName(tagName: ts.JsxTagNameExpression): boolean {
  return ts.isIdentifier(tagName) && tagName.text === "BrowserRouter";
}

function buildPreviewBasenameValue() {
  return ts.factory.createBinaryExpression(
    ts.factory.createCallExpression(
      ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier("Reflect"), "get"),
      undefined,
      [ts.factory.createIdentifier("globalThis"), ts.factory.createStringLiteral(ROUTER_PREVIEW_BASENAME_HELPER)],
    ),
    ts.SyntaxKind.BarBarToken,
    ts.factory.createIdentifier("undefined"),
  );
}

function buildPreviewBasenameHelperStatement() {
  return ts.factory.createVariableStatement(
    undefined,
    ts.factory.createVariableDeclarationList(
      [
        ts.factory.createVariableDeclaration(
          ROUTER_PREVIEW_BASENAME_HELPER,
          undefined,
          undefined,
          buildPreviewBasenameValue(),
        ),
      ],
      ts.NodeFlags.Const,
    ),
  );
}

function hasBasenameProperty(node: ts.ObjectLiteralExpression): boolean {
  return node.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      ((ts.isIdentifier(property.name) && property.name.text === "basename") ||
        (ts.isStringLiteral(property.name) && property.name.text === "basename")),
  );
}

function addBasenameToBrowserRouterAttributes(
  attributes: ts.JsxAttributes,
): ts.JsxAttributes {
  if (
    attributes.properties.some(
      (property) =>
        ts.isJsxAttribute(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === "basename",
    )
  ) {
    return attributes;
  }

  return ts.factory.updateJsxAttributes(attributes, [
    ...attributes.properties,
    ts.factory.createJsxAttribute(
      ts.factory.createIdentifier("basename"),
      ts.factory.createJsxExpression(undefined, ts.factory.createIdentifier(ROUTER_PREVIEW_BASENAME_HELPER)),
    ),
  ]);
}

function patchCreateBrowserRouterCall(node: ts.CallExpression): ts.CallExpression {
  const basenameProperty = ts.factory.createPropertyAssignment(
    "basename",
    ts.factory.createIdentifier(ROUTER_PREVIEW_BASENAME_HELPER),
  );

  if (!node.arguments.length) {
    return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, [
      ts.factory.createArrayLiteralExpression(),
      ts.factory.createObjectLiteralExpression([basenameProperty], true),
    ]);
  }

  if (node.arguments.length === 1) {
    return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, [
      node.arguments[0],
      ts.factory.createObjectLiteralExpression([basenameProperty], true),
    ]);
  }

  const [firstArgument, secondArgument, ...rest] = node.arguments;
  if (ts.isObjectLiteralExpression(secondArgument)) {
    if (hasBasenameProperty(secondArgument)) {
      return node;
    }

    return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, [
      firstArgument,
      ts.factory.updateObjectLiteralExpression(secondArgument, [
        ...secondArgument.properties,
        basenameProperty,
      ]),
      ...rest,
    ]);
  }

  return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, [
    firstArgument,
    ts.factory.createCallExpression(
      ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier("Object"), "assign"),
      undefined,
      [
        ts.factory.createObjectLiteralExpression(),
        secondArgument,
        ts.factory.createObjectLiteralExpression([basenameProperty], true),
      ],
    ),
    ...rest,
  ]);
}

function applyPreviewRouterCompatibility(sourceText: string, filePath: string): string {
  if (
    !hasJsLikeExtension(filePath) ||
    (!sourceText.includes("createBrowserRouter") && !sourceText.includes("BrowserRouter"))
  ) {
    return sourceText;
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(filePath),
  );

  let changed = false;
  let needsHelper = false;

  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const visit: ts.Visitor = (node) => {
      if (
        ts.isCallExpression(node) &&
        (isIdentifierNamed(node.expression, "createBrowserRouter") ||
          (ts.isPropertyAccessExpression(node.expression) &&
            isIdentifierNamed(node.expression.name, "createBrowserRouter")))
      ) {
        const updated = patchCreateBrowserRouterCall(node);
        if (updated !== node) {
          changed = true;
          needsHelper = true;
        }
        return updated;
      }

      if (ts.isJsxSelfClosingElement(node) && isBrowserRouterTagName(node.tagName)) {
        const updatedAttributes = addBasenameToBrowserRouterAttributes(node.attributes);
        if (updatedAttributes !== node.attributes) {
          changed = true;
          needsHelper = true;
          return ts.factory.updateJsxSelfClosingElement(
            node,
            node.tagName,
            node.typeArguments,
            updatedAttributes,
          );
        }
      }

      if (ts.isJsxOpeningElement(node) && isBrowserRouterTagName(node.tagName)) {
        const updatedAttributes = addBasenameToBrowserRouterAttributes(node.attributes);
        if (updatedAttributes !== node.attributes) {
          changed = true;
          needsHelper = true;
          return ts.factory.updateJsxOpeningElement(
            node,
            node.tagName,
            node.typeArguments,
            updatedAttributes,
          );
        }
      }

      return ts.visitEachChild(node, visit, context);
    };

    return (node) => ts.visitNode(node, visit) as ts.SourceFile;
  };

  const transformed = ts.transform(sourceFile, [transformer]);
  const nextSourceFile = transformed.transformed[0];

  let outputSource = nextSourceFile;
  if (changed && needsHelper && !sourceText.includes(`const ${ROUTER_PREVIEW_BASENAME_HELPER}`)) {
    const statements = [...nextSourceFile.statements];
    let insertIndex = 0;
    while (
      insertIndex < statements.length &&
      (ts.isImportDeclaration(statements[insertIndex]) ||
        ts.isImportEqualsDeclaration(statements[insertIndex]))
    ) {
      insertIndex += 1;
    }

    outputSource = ts.factory.updateSourceFile(nextSourceFile, [
      ...statements.slice(0, insertIndex),
      buildPreviewBasenameHelperStatement(),
      ...statements.slice(insertIndex),
    ]);
  }

  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const nextContent = printer.printFile(outputSource);
  transformed.dispose();

  return changed ? nextContent : sourceText;
}

export async function detectProjectRuntime(projectDir: string): Promise<ProjectRuntime | null> {
  const manifest = await readManifest(projectDir);
  if (manifest) {
    const dependencies = collectManifestDependencies(manifest);
    const devScript = manifest.scripts?.dev || "";
    const buildScript = manifest.scripts?.build || "";
    const scriptText = `${devScript} ${buildScript}`.toLowerCase();

    if (dependencies.next || scriptText.includes("next")) {
      return "next";
    }

    if (
      dependencies.vite ||
      scriptText.includes("vite") ||
      (await pathExists(path.join(projectDir, "vite.config.ts"))) ||
      (await pathExists(path.join(projectDir, "vite.config.js"))) ||
      (await pathExists(path.join(projectDir, "vite.config.mjs")))
    ) {
      return "vite";
    }
  }

  if (await pathExists(path.join(projectDir, "index.html"))) {
    return "static";
  }

  return null;
}

export function runtimeRequiresDependencyInstall(runtime: ProjectRuntime | null): boolean {
  return runtime === "next" || runtime === "vite";
}

export async function normalizeImportedProject(projectDir: string): Promise<void> {
  const packageJsonPath = path.join(projectDir, "package.json");
  const manifest = await readManifest(projectDir);
  const runtime = await detectProjectRuntime(projectDir);

  if (runtime === "static") {
    await ensureStaticEditableOverridesSupport(projectDir);
  }

  if (!manifest) {
    return;
  }

  const peerDependencies = manifest.peerDependencies || {};
  const devDependencies = manifest.devDependencies || {};
  const nextDependencies = {
    ...(manifest.dependencies || {}),
  };

  let changed = false;
  for (const dependency of ["react", "react-dom"]) {
    if (
      !nextDependencies[dependency] &&
      !devDependencies[dependency] &&
      peerDependencies[dependency]
    ) {
      nextDependencies[dependency] = peerDependencies[dependency];
      changed = true;
    }
  }

  if (changed) {
    manifest.dependencies = nextDependencies;
    await fs.writeFile(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  const assetRoot = path.join(projectDir, "src", "assets");
  if (!(await pathExists(assetRoot))) {
    return;
  }

  const assetFiles = new Set(
    (await listFiles(assetRoot)).map((relativePath) => relativePath.split(path.sep).join("/")),
  );
  const projectFiles = await listFiles(projectDir);

  for (const relativePath of projectFiles) {
    const extension = path.extname(relativePath).toLowerCase();
    if (!TEXT_SOURCE_EXTENSIONS.has(extension)) {
      continue;
    }

    const absolutePath = path.join(projectDir, relativePath);
    const originalContent = await fs.readFile(absolutePath, "utf8");
    const nextContent = originalContent.replace(/figma:asset\/([A-Za-z0-9._-]+)/g, (match, assetName) => {
      if (!assetFiles.has(assetName)) {
        return match;
      }

      const sourceDirectory = path.dirname(absolutePath);
      const assetPath = path.join(assetRoot, assetName);
      const relativeAssetPath = path.relative(sourceDirectory, assetPath).split(path.sep).join("/");
      return relativeAssetPath.startsWith(".") ? relativeAssetPath : `./${relativeAssetPath}`;
    });

    const routerCompatibleContent = applyPreviewRouterCompatibility(nextContent, absolutePath);
    if (routerCompatibleContent !== originalContent) {
      await fs.writeFile(absolutePath, routerCompatibleContent, "utf8");
    }
  }

  if (runtime === "static") {
    await ensureStaticEditableOverridesSupport(projectDir);
  }
}

export async function detectPackageManager(projectDir: string): Promise<PackageManager> {
  if (await pathExists(path.join(projectDir, "pnpm-lock.yaml"))) {
    return "pnpm";
  }

  if (await pathExists(path.join(projectDir, "yarn.lock"))) {
    return "yarn";
  }

  return "npm";
}

export async function validateProjectDirectory(projectDir: string): Promise<ValidationResult> {
  const packageManager = await detectPackageManager(projectDir);
  const runtime = await detectProjectRuntime(projectDir);
  if (!runtime) {
    return {
      ok: false,
      packageManager,
      reason:
        "The uploaded project must be a supported frontend app built with Next.js, Vite, or a static Framer-style export.",
    };
  }

  const manifest = await readManifest(projectDir);
  if (!manifest && runtime !== "static") {
    return {
      ok: false,
      packageManager,
      reason: "The uploaded zip does not contain a package.json file.",
    };
  }

  if (!manifest) {
    return { ok: true, packageManager, runtime };
  }

  if (manifest.workspaces) {
    return {
      ok: false,
      packageManager,
      reason: "Monorepos are not supported in v1. Upload a single frontend app instead.",
    };
  }

  const dependencies = collectManifestDependencies(manifest);
  if (runtimeRequiresDependencyInstall(runtime)) {
    const hasNext = Boolean(dependencies.next);
    const hasVite = Boolean(dependencies.vite);
    const hasReact = Boolean(dependencies.react);
    const hasReactDom = Boolean(dependencies["react-dom"]);
    if ((!hasNext && !hasVite) || !hasReact || !hasReactDom) {
      return {
        ok: false,
        packageManager,
        reason: "The uploaded project must include React and React DOM, and use Next.js or Vite.",
      };
    }
  }

  if (runtime === "next") {
    const hasAppRouter = await pathExists(path.join(projectDir, "app"));
    const hasPagesRouter = await pathExists(path.join(projectDir, "pages"));
    if (!hasAppRouter && !hasPagesRouter) {
      return {
        ok: false,
        packageManager,
        reason: "Next.js uploads must include an app/ or pages/ directory.",
      };
    }

    if (await pathExists(path.join(projectDir, "app", "api"))) {
      return {
        ok: false,
        packageManager,
        reason: "Projects with app/api routes are out of scope for MyMake v1.",
      };
    }

    if (await pathExists(path.join(projectDir, "pages", "api"))) {
      return {
        ok: false,
        packageManager,
        reason: "Projects with pages/api routes are out of scope for MyMake v1.",
      };
    }
  }

  if (runtime === "vite") {
    const hasIndexHtml = await pathExists(path.join(projectDir, "index.html"));
    const hasEntryPoint =
      (await pathExists(path.join(projectDir, "src", "main.tsx"))) ||
      (await pathExists(path.join(projectDir, "src", "main.jsx"))) ||
      (await pathExists(path.join(projectDir, "src", "main.ts"))) ||
      (await pathExists(path.join(projectDir, "src", "main.js")));

    if (!hasIndexHtml || !hasEntryPoint) {
      return {
        ok: false,
        packageManager,
        reason: "Vite uploads must include index.html and a src/main.* entry file.",
      };
    }
  }

  if (runtime === "static") {
    const hasIndexHtml = await pathExists(path.join(projectDir, "index.html"));
    if (!hasIndexHtml) {
      return {
        ok: false,
        packageManager,
        reason: "Static uploads must include an index.html file at the project root.",
      };
    }
  }

  for (const dependency of DISALLOWED_DEPENDENCIES) {
    if (dependency in dependencies) {
      return {
        ok: false,
        packageManager,
        reason: `This project depends on ${dependency}, which usually requires external services that v1 does not run.`,
      };
    }
  }

  return { ok: true, packageManager, runtime };
}
