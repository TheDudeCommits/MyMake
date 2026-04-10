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
        return {
          route: getPreviewRoute(),
          url: window.location.href,
          domPath: buildDomPath(element),
          tagName: element.tagName.toLowerCase(),
          textContent: (element.textContent || "").trim().slice(0, 600),
          attributes: attributeMap(element),
          classes: Array.from(element.classList),
          outerHtml: element.outerHTML.slice(0, 5000),
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
