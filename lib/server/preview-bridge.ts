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

      function getNearbyTextContext(element) {
        const values = [];
        const addValue = (value) => {
          const normalized = String(value || "").replace(/\\s+/g, " ").trim();
          if (!normalized || normalized.length < 2 || normalized.length > 120) {
            return;
          }
          if (!values.includes(normalized)) {
            values.push(normalized);
          }
        };

        addValue(element.textContent || "");

        let current = element.parentElement;
        let depth = 0;
        while (current && current !== document.body && depth < 3) {
          addValue(current.getAttribute("data-framer-name"));
          addValue(current.textContent || "");
          current = current.parentElement;
          depth += 1;
        }

        const parent = element.parentElement;
        if (parent) {
          Array.from(parent.children)
            .filter((child) => child !== element)
            .slice(0, 4)
            .forEach((child) => {
              addValue(child.getAttribute("data-framer-name"));
              addValue(child.textContent || "");
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

      function currentSelectionPayload(element) {
        const rect = element.getBoundingClientRect();
        const framerRoot = getNearestFramerRoot(element);
        const selector = buildSelector(element, null);
        const scopeSelector =
          framerRoot && framerRoot instanceof Element
            ? buildSelector(framerRoot, null)
            : null;
        const scopedSelector =
          framerRoot && framerRoot !== element
            ? buildSelector(element, framerRoot)
            : null;
        const contextTexts = getNearbyTextContext(element);
        const visualType = detectVisualType(element);
        return {
          route: getPreviewRoute(),
          url: window.location.href,
          domPath: buildDomPath(element),
          selector,
          scopeSelector,
          scopedSelector,
          nearestFramerName: framerRoot ? framerRoot.getAttribute("data-framer-name") : null,
          framerPath: getFramerAncestors(element),
          tagName: element.tagName.toLowerCase(),
          textContent: (element.textContent || "").trim().slice(0, 600),
          attributes: attributeMap(element),
          classes: Array.from(element.classList),
          outerHtml: element.outerHTML.slice(0, 5000),
          role: element.getAttribute("role"),
          href: element instanceof HTMLAnchorElement ? element.href : element.getAttribute("href"),
          src:
            element instanceof HTMLImageElement
              ? element.currentSrc || element.src
              : element.getAttribute("src"),
          editableProperties: inferEditableProperties(element),
          fingerprint: buildFingerprint(element, scopeSelector, scopedSelector),
          instanceScope:
            element.getAttribute("data-framer-appear-id") ||
            framerRoot?.getAttribute("data-framer-appear-id") ||
            scopeSelector,
          contextTexts,
          visualType,
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
        selectedElement = element;
        updateOverlay(element);
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

          updateOverlay(event.target);
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
