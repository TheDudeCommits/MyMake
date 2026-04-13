export function buildPreviewBootstrapScript(projectId: string): string {
  return `
    window.__MYMAKE_PREVIEW_PROJECT_ID__ = ${JSON.stringify(projectId)};
    window.__MYMAKE_PREVIEW_BASENAME__ = ${JSON.stringify(`/preview/${projectId}`)};
  `;
}

export function buildPreviewBridgeScript(projectId: string): string {
  return `
    (() => {
      const CHANNEL = "MYMAKE_PREVIEW_BRIDGE";
      const PROJECT_ID = ${JSON.stringify(projectId)};
      const OVERLAY_ID = "__mymake_overlay__";
      let isPicking = false;
      let selectedElement = null;
      let suppressClickUntil = 0;

      function getPreviewRoute() {
        const parts = window.location.pathname.split("/").filter(Boolean);
        if (parts[0] === "preview" && parts[1] === PROJECT_ID) {
          const route = "/" + parts.slice(2).join("/");
          return route === "/" ? "/" : route.replace(/\\/$/, "") || "/";
        }
        return window.location.pathname || "/";
      }

      function toBox(rect) {
        return {
          x: Math.round(rect.left + window.scrollX),
          y: Math.round(rect.top + window.scrollY),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      }

      function attributeMap(element) {
        const output = {};
        for (const attribute of Array.from(element.attributes)) {
          output[attribute.name] = attribute.value;
        }
        return output;
      }

      function cssEscape(value) {
        if (window.CSS && typeof window.CSS.escape === "function") {
          return window.CSS.escape(value);
        }

        return String(value).replace(/"/g, '\\"');
      }

      function buildDomPath(element) {
        const segments = [];
        let current = element;
        while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
          let segment = current.tagName.toLowerCase();
          if (current.id) {
            segment += "#" + current.id;
            segments.unshift(segment);
            break;
          }

          if (current.classList.length) {
            segment += "." + Array.from(current.classList).slice(0, 2).join(".");
          }

          const parent = current.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter(
              (child) => child.tagName === current.tagName,
            );
            if (siblings.length > 1) {
              segment += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
            }
          }

          segments.unshift(segment);
          current = current.parentElement;
        }

        return segments.join(" > ");
      }

      function buildSelectorSegment(element) {
        if (!(element instanceof Element)) {
          return "";
        }

        if (element.id) {
          return "#" + cssEscape(element.id);
        }

        if (element.hasAttribute("data-framer-appear-id")) {
          return '[data-framer-appear-id="' + cssEscape(element.getAttribute("data-framer-appear-id")) + '"]';
        }

        if (element.hasAttribute("data-framer-name")) {
          return '[data-framer-name="' + cssEscape(element.getAttribute("data-framer-name")) + '"]';
        }

        let segment = element.tagName.toLowerCase();
        const preferredClasses = Array.from(element.classList)
          .filter((className) => className && !/^hidden-/.test(className))
          .slice(0, 2);

        if (preferredClasses.length) {
          segment += "." + preferredClasses.map(cssEscape).join(".");
        }

        const parent = element.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(
            (child) => child.tagName === element.tagName,
          );
          if (siblings.length > 1) {
            segment += ":nth-of-type(" + (siblings.indexOf(element) + 1) + ")";
          }
        }

        return segment;
      }

      function buildSelector(element, stopAt) {
        if (!(element instanceof Element)) {
          return null;
        }

        const segments = [];
        let current = element;
        while (current && current !== document.body && current !== stopAt) {
          const segment = buildSelectorSegment(current);
          if (!segment) {
            break;
          }

          segments.unshift(segment);
          if (segment.startsWith("#")) {
            break;
          }
          current = current.parentElement;
        }

        return segments.length ? segments.join(" > ") : null;
      }

      function getFramerAncestors(element) {
        const names = [];
        let current = element;
        while (current && current instanceof Element && current !== document.body) {
          const framerName = current.getAttribute("data-framer-name");
          if (framerName) {
            names.unshift(framerName);
          }
          current = current.parentElement;
        }
        return names;
      }

      function getNearestFramerRoot(element) {
        let current = element;
        while (current && current instanceof Element && current !== document.body) {
          if (current.hasAttribute("data-framer-name")) {
            return current;
          }
          current = current.parentElement;
        }
        return null;
      }

      function getComputedStyleSafe(element) {
        try {
          return window.getComputedStyle(element);
        } catch {
          return null;
        }
      }

      function normalizeTextValue(value) {
        return String(value || "").replace(/\\s+/g, " ").trim();
      }

      function addUniqueTextValue(values, value, maxLength) {
        const normalized = normalizeTextValue(value);
        if (!normalized || normalized.length < 2 || normalized.length > (maxLength || 120)) {
          return;
        }
        if (!values.includes(normalized)) {
          values.push(normalized);
        }
      }

      function collectTextFragments(root, limit) {
        const values = [];
        if (!(root instanceof Element)) {
          return values;
        }

        addUniqueTextValue(values, root.getAttribute("aria-label"), 80);
        addUniqueTextValue(values, root.getAttribute("title"), 80);
        addUniqueTextValue(values, root.getAttribute("data-framer-name"), 80);

        try {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
              const normalized = normalizeTextValue(node.textContent || "");
              return normalized.length >= 2 && normalized.length <= 80
                ? NodeFilter.FILTER_ACCEPT
                : NodeFilter.FILTER_REJECT;
            },
          });

          let current = walker.nextNode();
          while (current && values.length < (limit || 6)) {
            addUniqueTextValue(values, current.textContent || "", 80);
            current = walker.nextNode();
          }
        } catch {
          addUniqueTextValue(values, root.textContent || "", 80);
        }

        return values;
      }

      function isChartPrimitive(element) {
        if (!(element instanceof Element)) {
          return false;
        }

        const tagName = element.tagName.toLowerCase();
        if (!element.closest("svg")) {
          return false;
        }

        return ["path", "line", "polyline", "circle", "rect", "polygon", "svg"].includes(tagName);
      }

      function normalizeSelectionElement(element) {
        if (!(element instanceof Element) || !isChartPrimitive(element)) {
          return element;
        }

        let best = element;
        let bestScore = -Infinity;
        let current = element;
        let depth = 0;

        while (current && current !== document.body && depth < 6) {
          let score = 0;
          const descriptor = (
            (current.getAttribute("data-framer-name") || "") +
            " " +
            (typeof current.className === "string" ? current.className : "") +
            " " +
            current.tagName.toLowerCase()
          ).toLowerCase();
          const textFragments = collectTextFragments(current, 4);
          const rect = current.getBoundingClientRect();

          if (textFragments.length) {
            score += Math.min(8, textFragments.length * 2);
          }
          if (/(card|chart|breakdown|overview|analysis|panel|section|widget)/.test(descriptor)) {
            score += 6;
          }
          if (current.hasAttribute("data-framer-name") || current.hasAttribute("data-framer-appear-id")) {
            score += 4;
          }
          if (/^(article|section|figure|li|div)$/i.test(current.tagName)) {
            score += 3;
          }
          if (current.querySelector && current.querySelector("svg")) {
            score += 2;
          }
          if (rect.width >= 120 && rect.height >= 36) {
            score += 2;
          }
          if (depth === 0) {
            score -= 6;
          }

          if (score > bestScore) {
            best = current;
            bestScore = score;
          }

          current = current.parentElement;
          depth += 1;
        }

        return best || element;
      }

      function getNearbyTextContext(element) {
        const values = [];
        collectTextFragments(element, 6).forEach((value) => addUniqueTextValue(values, value, 80));

        let current = element.parentElement;
        let depth = 0;
        while (current && current !== document.body && depth < 3) {
          addUniqueTextValue(values, current.getAttribute("data-framer-name"), 80);
          collectTextFragments(current, 3).forEach((value) => addUniqueTextValue(values, value, 80));
          current = current.parentElement;
          depth += 1;
        }

        const parent = element.parentElement;
        if (parent) {
          Array.from(parent.children)
            .filter((child) => child !== element)
            .slice(0, 4)
            .forEach((child) => {
              addUniqueTextValue(values, child.getAttribute("data-framer-name"), 80);
              collectTextFragments(child, 2).forEach((value) => addUniqueTextValue(values, value, 80));
            });
        }

        return values.slice(0, 8);
      }

      function detectVisualType(element) {
        const tagName = element.tagName.toLowerCase();
        const parentTag = element.parentElement ? element.parentElement.tagName.toLowerCase() : "";
        if (tagName === "img") {
          return "image";
        }
        if (tagName === "svg") {
          return "vector";
        }
        if (tagName === "path" || tagName === "line" || tagName === "polyline") {
          if (parentTag === "svg" || element.closest("svg")) {
            const hasStroke = element.getAttribute("stroke");
            const hasFill = element.getAttribute("fill");
            if (hasStroke && (!hasFill || hasFill === "none")) {
              return "chart-line";
            }
            if (hasFill && hasFill !== "none") {
              return "chart-area";
            }
            return "vector-path";
          }
        }
        if (/button|a/.test(tagName) || element.getAttribute("role") === "button") {
          return "interactive";
        }
        if (/h1|h2|h3|h4|h5|h6|p|span|strong|em|label/.test(tagName)) {
          return "text";
        }
        return "container";
      }

      function buildFingerprint(element, scopeSelector, scopedSelector) {
        const parts = [
          element.tagName.toLowerCase(),
          element.getAttribute("data-framer-appear-id") || "",
          element.getAttribute("data-framer-name") || "",
          element.getAttribute("role") || "",
          (element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80),
          scopeSelector || "",
          scopedSelector || "",
        ];
        return parts.filter(Boolean).join("::");
      }

      function getReactFiberNode(element) {
        let current = element;
        let depth = 0;

        while (current && current instanceof Element && depth < 4) {
          const keys = Object.keys(current);
          for (const key of keys) {
            if (key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")) {
              return current[key];
            }
          }
          current = current.parentElement;
          depth += 1;
        }

        return null;
      }

      function getFiberDisplayName(fiber) {
        const type = fiber?.type || fiber?.elementType;
        if (!type || typeof type === "string") {
          return null;
        }
        return type.displayName || type.name || null;
      }

      function collectReactPropHints(props, output, limit) {
        if (!props || typeof props !== "object") {
          return;
        }

        const candidateKeys = ["label", "title", "subtitle", "name", "id", "metric", "section", "variant"];
        candidateKeys.forEach((key) => {
          const value = props[key];
          if (typeof value === "string") {
            addUniqueTextValue(output, value, 80);
          } else if (Array.isArray(value)) {
            value
              .filter((item) => typeof item === "string")
              .slice(0, 3)
              .forEach((item) => addUniqueTextValue(output, item, 80));
          }
        });

        if (output.length > (limit || 12)) {
          output.length = limit || 12;
        }
      }

      function getReactDebugContext(element) {
        const componentStack = [];
        const sourceHints = [];
        let fiber = getReactFiberNode(element);
        let depth = 0;

        while (fiber && depth < 14) {
          const name = getFiberDisplayName(fiber);
          if (name && !/^(ForwardRef|Memo|Anonymous)$/.test(name)) {
            addUniqueTextValue(componentStack, name, 80);
            addUniqueTextValue(sourceHints, name, 80);
          }

          const debugSource = fiber?._debugSource || fiber?._debugOwner?._debugSource;
          const fileName =
            debugSource && typeof debugSource.fileName === "string" ? debugSource.fileName : null;
          if (fileName) {
            const base = fileName.split("/").pop() || fileName;
            addUniqueTextValue(sourceHints, base, 120);
            addUniqueTextValue(sourceHints, base.replace(/\\.[^.]+$/, ""), 120);
          }

          collectReactPropHints(fiber.memoizedProps, sourceHints, 12);
          fiber = fiber.return;
          depth += 1;
        }

        return {
          componentStack: componentStack.slice(0, 8),
          sourceHints: sourceHints.slice(0, 12),
        };
      }

      function inferEditableProperties(element) {
        const style = getComputedStyleSafe(element);
        const strokeValue =
          element.getAttribute("stroke") ||
          element.getAttribute("data-stroke") ||
          style?.stroke ||
          "";
        const fillValue =
          element.getAttribute("fill") ||
          style?.fill ||
          style?.backgroundColor ||
          "";
        const values = [
          ((element.textContent || "").trim() ? "text" : null),
          ((element instanceof HTMLAnchorElement || element.hasAttribute("href")) ? "link" : null),
          ((element instanceof HTMLImageElement || element.hasAttribute("src")) ? "image" : null),
          (strokeValue && strokeValue !== "none" ? "line-color" : null),
          (fillValue && fillValue !== "none" && fillValue !== "rgba(0, 0, 0, 0)" ? "fill-color" : null),
          (["button", "a"].includes(element.tagName.toLowerCase()) ? "spacing" : null),
          (style?.borderRadius && style.borderRadius !== "0px" ? "radius" : null),
          "visibility",
          "layout",
        ].filter(Boolean);
        return Array.from(new Set(values));
      }

      function ensureOverlay() {
        let overlay = document.getElementById(OVERLAY_ID);
        if (!overlay) {
          overlay = document.createElement("div");
          overlay.id = OVERLAY_ID;
          overlay.style.position = "absolute";
          overlay.style.pointerEvents = "none";
          overlay.style.zIndex = "2147483647";
          overlay.style.border = "2px solid rgba(96, 165, 250, 0.95)";
          overlay.style.background = "rgba(59, 130, 246, 0.12)";
          overlay.style.boxShadow = "0 0 0 9999px rgba(10, 14, 24, 0.08)";
          overlay.style.transition = "all 80ms ease-out";
          document.body.appendChild(overlay);
        }
        return overlay;
      }

      function updateOverlay(element) {
        if (!element) {
          return;
        }

        const overlay = ensureOverlay();
        const rect = element.getBoundingClientRect();
        overlay.style.top = window.scrollY + rect.top + "px";
        overlay.style.left = window.scrollX + rect.left + "px";
        overlay.style.width = rect.width + "px";
        overlay.style.height = rect.height + "px";
        overlay.style.display = "block";
      }

      function emit(type, payload) {
        window.parent.postMessage({ channel: CHANNEL, type, payload }, "*");
      }

      function setPicking(nextValue) {
        isPicking = Boolean(nextValue);
        emit("MYMAKE_PICKING", { enabled: isPicking });
      }

      function isSelectableElement(value) {
        return (
          value instanceof Element &&
          value.id !== OVERLAY_ID &&
          value !== document.documentElement &&
          value !== document.body
        );
      }

      function buildSelectionAttributes(rawElement, semanticElement) {
        const attributes = attributeMap(rawElement);
        const rawStyle = getComputedStyleSafe(rawElement);
        const semanticStyle = rawElement === semanticElement ? rawStyle : getComputedStyleSafe(semanticElement);
        const strokeValue =
          rawElement.getAttribute("stroke") ||
          rawStyle?.stroke ||
          "";
        const fillValue =
          rawElement.getAttribute("fill") ||
          rawStyle?.fill ||
          "";

        if (strokeValue && strokeValue !== "none") {
          attributes.stroke = strokeValue;
        }
        if (fillValue && fillValue !== "none" && fillValue !== "rgba(0, 0, 0, 0)") {
          attributes.fill = fillValue;
        }
        if (
          semanticStyle?.backgroundColor &&
          semanticStyle.backgroundColor !== "rgba(0, 0, 0, 0)"
        ) {
          attributes["background-color"] = semanticStyle.backgroundColor;
        }

        return attributes;
      }

      function currentSelectionPayload(element) {
        const semanticElement = normalizeSelectionElement(element);
        const rect = semanticElement.getBoundingClientRect();
        const framerRoot = getNearestFramerRoot(semanticElement);
        const selector = buildSelector(semanticElement, null);
        const scopeSelector =
          framerRoot && framerRoot instanceof Element
            ? buildSelector(framerRoot, null)
            : null;
        const scopedSelector =
          framerRoot && framerRoot !== semanticElement
            ? buildSelector(semanticElement, framerRoot)
            : null;
        const contextTexts = getNearbyTextContext(semanticElement);
        const visualType = detectVisualType(element);
        const reactDebug = getReactDebugContext(element);
        return {
          route: getPreviewRoute(),
          url: window.location.href,
          domPath: buildDomPath(semanticElement),
          selector,
          scopeSelector,
          scopedSelector,
          nearestFramerName: framerRoot ? framerRoot.getAttribute("data-framer-name") : null,
          framerPath: getFramerAncestors(semanticElement),
          tagName: semanticElement.tagName.toLowerCase(),
          textContent: normalizeTextValue(semanticElement.textContent || "").slice(0, 600),
          attributes: buildSelectionAttributes(element, semanticElement),
          classes: Array.from(semanticElement.classList),
          outerHtml: semanticElement.outerHTML.slice(0, 5000),
          role: semanticElement.getAttribute("role"),
          href:
            semanticElement instanceof HTMLAnchorElement
              ? semanticElement.href
              : semanticElement.getAttribute("href"),
          src:
            semanticElement instanceof HTMLImageElement
              ? semanticElement.currentSrc || semanticElement.src
              : semanticElement.getAttribute("src"),
          editableProperties: inferEditableProperties(element),
          fingerprint: buildFingerprint(semanticElement, scopeSelector, scopedSelector) + "::" + visualType,
          instanceScope:
            semanticElement.getAttribute("data-framer-appear-id") ||
            framerRoot?.getAttribute("data-framer-appear-id") ||
            scopeSelector,
          contextTexts,
          visualType,
          reactComponentStack: reactDebug.componentStack,
          reactSourceHints: reactDebug.sourceHints,
          boundingBox: toBox(rect),
        };
      }

      function emitRoute() {
        emit("MYMAKE_ROUTE", {
          route: getPreviewRoute(),
          url: window.location.href,
        });
      }

      function selectElement(element) {
        selectedElement = normalizeSelectionElement(element);
        updateOverlay(selectedElement);
        setPicking(false);
        emit("MYMAKE_SELECT", currentSelectionPayload(element));
      }

      window.addEventListener("message", (event) => {
        if (!event.data || event.data.channel !== CHANNEL) {
          return;
        }

        if (event.data.type === "MYMAKE_SET_PICKING") {
          isPicking = Boolean(event.data.payload?.enabled);
          if (!isPicking) {
            const overlay = document.getElementById(OVERLAY_ID);
            if (overlay && !selectedElement) {
              overlay.style.display = "none";
            }
            if (selectedElement) {
              updateOverlay(selectedElement);
            }
          }
        }

        if (event.data.type === "MYMAKE_PING") {
          emit("MYMAKE_READY", {
            route: getPreviewRoute(),
            url: window.location.href,
          });
        }
      });

      document.addEventListener(
        "pointermove",
        (event) => {
          if (!isPicking || !isSelectableElement(event.target)) {
            return;
          }

          updateOverlay(normalizeSelectionElement(event.target));
        },
        true,
      );

      document.addEventListener(
        "pointerdown",
        (event) => {
          if (!isPicking || !isSelectableElement(event.target)) {
            return;
          }

          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          suppressClickUntil = Date.now() + 600;
          selectElement(event.target);
        },
        true,
      );

      document.addEventListener(
        "click",
        (event) => {
          if (Date.now() >= suppressClickUntil) {
            return;
          }

          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          suppressClickUntil = 0;
        },
        true,
      );

      const originalPushState = history.pushState;
      const originalReplaceState = history.replaceState;

      history.pushState = function (...args) {
        originalPushState.apply(history, args);
        emitRoute();
      };

      history.replaceState = function (...args) {
        originalReplaceState.apply(history, args);
        emitRoute();
      };

      window.addEventListener("popstate", emitRoute);
      window.addEventListener("load", () => {
        emit("MYMAKE_READY", {
          route: getPreviewRoute(),
          url: window.location.href,
        });
        emitRoute();
      });
    })();
  `;
}
