import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

export const OVERRIDES_CONFIG_PATH = "editable/overrides.config.js";
export const OVERRIDES_ENGINE_PATH = "editable/overrides.engine.js";
export const OVERRIDES_CSS_PATH = "editable/overrides.css";
export const OVERRIDES_README_PATH = "editable/README.md";
export const OVERRIDES_SECTION_HOOKS_PATH = "editable/section-hooks.md";
export const OVERRIDES_SECTION_NAMES_PATH = "editable/section-names.txt";

const PLATFORM_OVERRIDES_ENGINE_SOURCE = `(function () {
  "use strict";

  var DISALLOWED_TEXT_PARENTS = {
    SCRIPT: true,
    STYLE: true,
    NOSCRIPT: true,
    TEXTAREA: true
  };

  function isUnsafeTextParent(node) {
    var parent = node && node.parentElement;
    if (!parent) return false;
    return Boolean(DISALLOWED_TEXT_PARENTS[parent.tagName]);
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }
    return String(value).replace(/"/g, '\\\\"');
  }

  function toArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function normalizeRoot(base) {
    if (!base || typeof base.querySelectorAll !== "function") {
      return document;
    }
    return base;
  }

  function baseNode(base) {
    return base === document ? document.documentElement : base;
  }

  function setStyles(el, styles) {
    if (!el || !styles || typeof styles !== "object") return;
    Object.entries(styles).forEach(function (entry) {
      var key = entry[0];
      var value = entry[1];
      try {
        el.style[key] = value;
      } catch (_) {
        /* ignore invalid style keys */
      }
    });
  }

  function setCssVars(el, cssVars) {
    if (!el || !cssVars || typeof cssVars !== "object") return;
    Object.entries(cssVars).forEach(function (entry) {
      el.style.setProperty(entry[0], String(entry[1]));
    });
  }

  function applyAttributes(el, attributes) {
    if (!el || !attributes || typeof attributes !== "object") return;
    Object.entries(attributes).forEach(function (entry) {
      el.setAttribute(entry[0], String(entry[1]));
    });
  }

  function pickNodes(base, selector, index, all) {
    var searchRoot = normalizeRoot(base);
    var nodes = selector
      ? Array.from(searchRoot.querySelectorAll(selector))
      : [baseNode(searchRoot)];

    if (typeof index === "number") {
      return nodes[index] ? [nodes[index]] : [];
    }

    return all ? nodes : (nodes[0] ? [nodes[0]] : []);
  }

  function replaceInTextNode(node, find, replace, all) {
    if (!node || node.nodeType !== Node.TEXT_NODE) return;
    if (!find) return;
    if (find === replace) return;
    if (isUnsafeTextParent(node)) return;
    if (all) {
      node.nodeValue = node.nodeValue.split(find).join(replace);
      return;
    }
    node.nodeValue = node.nodeValue.replace(find, replace);
  }

  function replaceWithinNode(root, find, replace, all) {
    if (!root || !find || typeof replace !== "string") return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var current;
    while ((current = walker.nextNode())) {
      replaceInTextNode(current, find, replace, Boolean(all));
    }
  }

  function applyTextOperations(root, operations) {
    toArray(operations).forEach(function (op) {
      var selector = op.selector || "";
      var nodes = pickNodes(root, selector, op.index, op.all);

      nodes.forEach(function (node) {
        if (typeof op.text === "string") {
          node.textContent = op.text;
          return;
        }

        if (op.find && typeof op.replace === "string") {
          replaceWithinNode(node, op.find, op.replace, Boolean(op.all));
        }
      });
    });
  }

  function applyImageOperations(root, operations) {
    toArray(operations).forEach(function (op) {
      var nodes = pickNodes(root, op.selector || "img", op.index, op.all);
      nodes.forEach(function (node) {
        if (!(node instanceof HTMLImageElement)) return;
        if (typeof op.src === "string") node.src = op.src;
        if (typeof op.alt === "string") node.alt = op.alt;
        if (typeof op.srcset === "string") node.srcset = op.srcset;
        if (op.clearSrcset) node.removeAttribute("srcset");
      });
    });
  }

  function applyLinkOperations(root, operations) {
    toArray(operations).forEach(function (op) {
      var nodes = pickNodes(root, op.selector || "a", op.index, op.all);
      nodes.forEach(function (node) {
        if (!(node instanceof HTMLAnchorElement)) return;
        if (typeof op.href === "string") node.href = op.href;
        if (typeof op.target === "string") node.target = op.target;
        if (typeof op.rel === "string") node.rel = op.rel;
      });
    });
  }

  function applyElementOverrides(operations) {
    toArray(operations).forEach(function (op) {
      if (!op || typeof op !== "object") return;

      var roots = op.scopeSelector
        ? Array.from(document.querySelectorAll(op.scopeSelector))
        : [document];

      roots.forEach(function (root) {
        var nodes = pickNodes(root, op.selector || "", op.index, op.all);
        nodes.forEach(function (node) {
          if (!(node instanceof Element)) return;

          if (op.hide || op.remove) {
            node.classList.add("is-hidden-by-override");
          }

          setStyles(node, op.styles);
          setCssVars(node, op.cssVars);
          applyAttributes(node, op.attributes);

          if (typeof op.removeAttribute === "string" && op.removeAttribute) {
            node.removeAttribute(op.removeAttribute);
          }

          if (typeof op.html === "string") {
            node.innerHTML = op.html;
          } else if (typeof op.text === "string") {
            node.textContent = op.text;
          } else if (op.find && typeof op.replace === "string") {
            replaceWithinNode(node, op.find, op.replace, Boolean(op.all));
          }

          if (node instanceof HTMLImageElement) {
            if (typeof op.src === "string") node.src = op.src;
            if (typeof op.alt === "string") node.alt = op.alt;
            if (typeof op.srcset === "string") node.srcset = op.srcset;
            if (op.clearSrcset) node.removeAttribute("srcset");
          }

          if (node instanceof HTMLAnchorElement) {
            if (typeof op.href === "string") node.href = op.href;
            if (typeof op.target === "string") node.target = op.target;
            if (typeof op.rel === "string") node.rel = op.rel;
          }
        });
      });
    });
  }

  function injectCustomCss(cssText) {
    if (!cssText || typeof cssText !== "string") return;
    var style = document.getElementById("platform-runtime-overrides");
    if (!style) {
      style = document.createElement("style");
      style.id = "platform-runtime-overrides";
      document.head.appendChild(style);
    }
    style.textContent = cssText;
  }

  function applyGlobalTextReplacements(replacements) {
    toArray(replacements).forEach(function (rep) {
      if (!rep || !rep.find || typeof rep.replace !== "string") return;
      var scope = rep.scopeSelector
        ? document.querySelector(rep.scopeSelector)
        : document.body;
      if (!scope) return;

      var walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      var current;
      while ((current = walker.nextNode())) {
        replaceInTextNode(current, rep.find, rep.replace, Boolean(rep.all));
      }
    });
  }

  function applySectionOverrides(sections) {
    if (!sections || typeof sections !== "object") return;

    Object.entries(sections).forEach(function (entry) {
      var sectionName = entry[0];
      var options = entry[1] || {};
      var selector = '[data-framer-name="' + cssEscape(sectionName) + '"]';
      var roots = Array.from(document.querySelectorAll(selector));

      roots.forEach(function (root) {
        if (options.hide) {
          root.classList.add("is-hidden-by-override");
        }

        setStyles(root, options.styles);
        setCssVars(root, options.cssVars);
        applyTextOperations(root, options.text);
        applyImageOperations(root, options.images);
        applyLinkOperations(root, options.links);
      });
    });
  }

  function removeFramerBadge() {
    var badge = document.getElementById("__framer-badge-container");
    if (badge) badge.remove();
  }

  function applyOverrides() {
    var cfg = window.__PLATFORM_OVERRIDES__ || {};
    if (!cfg.enabled) return;

    setCssVars(document.documentElement, cfg.rootCssVars);

    var globalCfg = cfg.global || {};
    if (globalCfg.removeFramerBadge) removeFramerBadge();
    applyGlobalTextReplacements(globalCfg.textReplacements);

    applySectionOverrides(cfg.sections);
    applyElementOverrides(cfg.elements);
    injectCustomCss(cfg.customCss);
  }

  var pending = null;
  var runCount = 0;
  var maxRuns = 4;
  var observer = null;

  function scheduleApply(delay) {
    if (pending) return;
    pending = window.setTimeout(function () {
      pending = null;
      applyOverrides();
      runCount += 1;
      if (observer && runCount >= maxRuns) {
        observer.disconnect();
        observer = null;
      }
    }, delay || 0);
  }

  document.addEventListener("DOMContentLoaded", function () {
    scheduleApply(0);
    window.setTimeout(function () {
      scheduleApply(0);
    }, 400);
    window.setTimeout(function () {
      scheduleApply(0);
    }, 1500);
  });

  observer = new MutationObserver(function () {
    if (runCount >= maxRuns) return;
    scheduleApply(80);
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
})();`;

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

interface OverrideConfigValue {
  enabled: boolean;
  elements: Array<Record<string, unknown>>;
  rootCssVars: Record<string, string>;
  global: Record<string, unknown>;
  sections: Record<string, unknown>;
  customCss: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function uniqueStringList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function uniqueObjectList(values: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const output: Array<Record<string, unknown>> = [];

  for (const value of values) {
    const fingerprint = JSON.stringify(value);
    if (seen.has(fingerprint)) {
      continue;
    }

    seen.add(fingerprint);
    output.push(value);
  }

  return output;
}

function findMatchingDelimiter(
  content: string,
  startIndex: number,
  openCharacter: string,
  closeCharacter: string,
): number {
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = startIndex; index < content.length; index += 1) {
    const character = content[index];
    const nextCharacter = content[index + 1] || "";

    if (inLineComment) {
      if (character === "\n") {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (character === "*" && nextCharacter === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (character === "\\") {
        escaped = true;
        continue;
      }

      if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === "/" && nextCharacter === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (character === "/" && nextCharacter === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }

    if (character === openCharacter) {
      depth += 1;
      continue;
    }

    if (character === closeCharacter) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function getAssignedObjectRange(content: string): { start: number; end: number } | null {
  const assignmentMatch = content.match(/window\.__PLATFORM_OVERRIDES__\s*=\s*/);
  if (!assignmentMatch || assignmentMatch.index === undefined) {
    return null;
  }

  const objectStart = content.indexOf("{", assignmentMatch.index + assignmentMatch[0].length);
  if (objectStart < 0) {
    return null;
  }

  const objectEnd = findMatchingDelimiter(content, objectStart, "{", "}");
  if (objectEnd < 0) {
    return null;
  }

  return { start: objectStart, end: objectEnd };
}

function findExpressionEnd(content: string, startIndex: number, limit: number): number {
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = startIndex; index < limit; index += 1) {
    const character = content[index];
    const nextCharacter = content[index + 1] || "";

    if (inLineComment) {
      if (character === "\n") {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (character === "*" && nextCharacter === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (character === "\\") {
        escaped = true;
        continue;
      }

      if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === "/" && nextCharacter === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (character === "/" && nextCharacter === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }

    if (character === "{") {
      braceDepth += 1;
      continue;
    }

    if (character === "}") {
      if (braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
        return index;
      }
      braceDepth -= 1;
      continue;
    }

    if (character === "[") {
      bracketDepth += 1;
      continue;
    }

    if (character === "]") {
      bracketDepth -= 1;
      continue;
    }

    if (character === "(") {
      parenDepth += 1;
      continue;
    }

    if (character === ")") {
      parenDepth -= 1;
      continue;
    }

    if (
      character === "," &&
      braceDepth === 0 &&
      bracketDepth === 0 &&
      parenDepth === 0
    ) {
      return index;
    }
  }

  return limit;
}

function extractTopLevelPropertyExpressions(content: string, key: string): string[] {
  const range = getAssignedObjectRange(content);
  if (!range) {
    return [];
  }

  const expressions: string[] = [];
  let index = range.start + 1;
  while (index < range.end) {
    while (index < range.end && /[\s,]/.test(content[index] || "")) {
      index += 1;
    }

    if (index >= range.end) {
      break;
    }

    if (!content.startsWith(key, index)) {
      index += 1;
      continue;
    }

    let cursor = index + key.length;
    while (cursor < range.end && /\s/.test(content[cursor] || "")) {
      cursor += 1;
    }

    if (content[cursor] !== ":") {
      index += 1;
      continue;
    }

    cursor += 1;
    while (cursor < range.end && /\s/.test(content[cursor] || "")) {
      cursor += 1;
    }

    const expressionEnd = findExpressionEnd(content, cursor, range.end);
    expressions.push(content.slice(cursor, expressionEnd).trim());
    index = expressionEnd + 1;
  }

  return expressions;
}

function evaluateExpression(expression: string): unknown {
  const script = new vm.Script(`(${expression})`);
  return script.runInNewContext({});
}

function readOverrideConfigValue(content: string): OverrideConfigValue {
  const sandbox = { window: {} as Record<string, unknown> };
  new vm.Script(content, { filename: OVERRIDES_CONFIG_PATH }).runInNewContext(sandbox);

  const baseValue = isPlainObject(sandbox.window.__PLATFORM_OVERRIDES__)
    ? sandbox.window.__PLATFORM_OVERRIDES__
    : {};

  const customCssValues = uniqueStringList(
    extractTopLevelPropertyExpressions(content, "customCss")
      .map((expression) => {
        try {
          const value = evaluateExpression(expression);
          return typeof value === "string" ? value : "";
        } catch {
          return "";
        }
      })
      .concat(typeof baseValue.customCss === "string" ? baseValue.customCss : ""),
  );

  const elementValues = uniqueObjectList(
    extractTopLevelPropertyExpressions(content, "elements")
      .map((expression) => {
        try {
          const value = evaluateExpression(expression);
          return Array.isArray(value)
            ? value.filter(isPlainObject).map((entry) => ({ ...entry }))
            : [];
        } catch {
          return [];
        }
      })
      .flat()
      .concat(
        Array.isArray(baseValue.elements)
          ? baseValue.elements.filter(isPlainObject).map((entry) => ({ ...entry }))
          : [],
      ),
  );

  const globalValue = isPlainObject(baseValue.global) ? { ...baseValue.global } : {};
  const rawTextReplacements = Array.isArray(globalValue.textReplacements)
    ? globalValue.textReplacements.filter(isPlainObject).map((entry) => ({ ...entry }))
    : [];
  globalValue.textReplacements = uniqueObjectList(rawTextReplacements);

  return {
    enabled: baseValue.enabled !== false,
    elements: elementValues,
    rootCssVars: isPlainObject(baseValue.rootCssVars)
      ? Object.fromEntries(
          Object.entries(baseValue.rootCssVars).map(([configKey, configValue]) => [
            configKey,
            String(configValue),
          ]),
        )
      : {},
    global: globalValue,
    sections: isPlainObject(baseValue.sections) ? { ...baseValue.sections } : {},
    customCss: customCssValues.join("\n\n"),
  };
}

function serializeOverrideConfigValue(value: OverrideConfigValue): string {
  return `window.__PLATFORM_OVERRIDES__ = ${JSON.stringify(value, null, 2)};\n`;
}

export function normalizeOverrideConfigContent(content: string): string {
  return serializeOverrideConfigValue(readOverrideConfigValue(content));
}

export function hasStaticEditableOverrides(files: string[]): boolean {
  return files.includes(OVERRIDES_CONFIG_PATH) && files.includes(OVERRIDES_ENGINE_PATH);
}

export function isEditableOverridesFile(filePath: string | null | undefined): boolean {
  return Boolean(filePath && filePath.startsWith("editable/"));
}

export function getPreferredStaticEditableFile(files: string[]): string | null {
  const priorities = [
    OVERRIDES_CONFIG_PATH,
    OVERRIDES_CSS_PATH,
    OVERRIDES_SECTION_HOOKS_PATH,
    OVERRIDES_README_PATH,
    OVERRIDES_SECTION_NAMES_PATH,
  ];

  return priorities.find((candidate) => files.includes(candidate)) || null;
}

export async function ensureStaticEditableOverridesSupport(projectDir: string): Promise<void> {
  const configPath = path.join(projectDir, OVERRIDES_CONFIG_PATH);
  const enginePath = path.join(projectDir, OVERRIDES_ENGINE_PATH);
  const cssPath = path.join(projectDir, OVERRIDES_CSS_PATH);

  if (await pathExists(configPath)) {
    const currentConfig = await fs.readFile(configPath, "utf8");
    const normalizedConfig = normalizeOverrideConfigContent(currentConfig);
    if (normalizedConfig !== currentConfig) {
      await fs.writeFile(configPath, normalizedConfig, "utf8");
    }
  }

  if (await pathExists(enginePath)) {
    const currentEngine = await fs.readFile(enginePath, "utf8");
    if (currentEngine.trim() !== PLATFORM_OVERRIDES_ENGINE_SOURCE.trim()) {
      await fs.writeFile(enginePath, `${PLATFORM_OVERRIDES_ENGINE_SOURCE}\n`, "utf8");
    }
  }

  if (!(await pathExists(cssPath))) {
    await fs.mkdir(path.dirname(cssPath), { recursive: true });
    await fs.writeFile(
      cssPath,
      "/* Prompt-editable style layer. */\n.is-hidden-by-override { display: none !important; }\n",
      "utf8",
    );
  }
}

export async function appendElementOverride(
  projectDir: string,
  entry: Record<string, unknown>,
): Promise<string> {
  const configPath = path.join(projectDir, OVERRIDES_CONFIG_PATH);
  const currentConfig = await fs.readFile(configPath, "utf8");
  const normalizedConfig = readOverrideConfigValue(currentConfig);
  normalizedConfig.elements = uniqueObjectList([...normalizedConfig.elements, entry]);
  const nextConfig = serializeOverrideConfigValue(normalizedConfig);
  if (nextConfig !== currentConfig) {
    await fs.writeFile(configPath, nextConfig, "utf8");
  }
  return nextConfig;
}
