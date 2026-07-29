import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeOverrideConfigContent,
  readOverrideConfigValue,
} from "@/lib/server/static-overrides";

test("override configuration accepts data-only JSON values", () => {
  const source = `window.__PLATFORM_OVERRIDES__ = {
    "enabled": true,
    "elements": [{"selector": ".hero", "text": "Safe"}],
    "rootCssVars": {"--accent": "#123456"},
    "global": {"textReplacements": [{"find": "Old", "replace": "New"}]},
    "sections": {},
    "customCss": ".hero { color: red; }"
  };\n`;

  const value = readOverrideConfigValue(source);
  assert.equal(value.enabled, true);
  assert.deepEqual(value.elements, [{ selector: ".hero", text: "Safe" }]);
  assert.deepEqual(value.rootCssVars, { "--accent": "#123456" });
  assert.equal(value.customCss, ".hero { color: red; }");
  assert.match(normalizeOverrideConfigContent(source), /^window\.__PLATFORM_OVERRIDES__ = \{/);
});

test("override configuration rejects executable property expressions", () => {
  const marker = "__mymake_override_expression_executed__";
  delete (globalThis as Record<string, unknown>)[marker];

  assert.throws(
    () =>
      readOverrideConfigValue(
        `window.__PLATFORM_OVERRIDES__ = {
          "enabled": true,
          "customCss": (() => {
            globalThis.${marker} = true;
            return "";
          })()
        };`,
      ),
    /JSON-compatible values without executable expressions/,
  );
  assert.equal((globalThis as Record<string, unknown>)[marker], undefined);
});

test("override configuration rejects statements before or after the assignment", () => {
  assert.throws(
    () =>
      readOverrideConfigValue(
        `globalThis.compromised = true;
         window.__PLATFORM_OVERRIDES__ = {"enabled": true};`,
      ),
    /must assign one JSON object/,
  );

  assert.throws(
    () =>
      readOverrideConfigValue(
        `window.__PLATFORM_OVERRIDES__ = {"enabled": true};
         globalThis.compromised = true;`,
      ),
    /may not contain executable statements/,
  );
});
