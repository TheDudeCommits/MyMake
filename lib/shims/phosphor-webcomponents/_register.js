export function registerPhosphorIcon(tagName) {
  if (typeof window === "undefined" || customElements.get(tagName)) {
    return;
  }

  class MyMakePhosphorIcon extends HTMLElement {
    connectedCallback() {
      if (this.shadowRoot) {
        return;
      }

      const root = this.attachShadow({ mode: "open" });
      root.innerHTML = `
        <style>
          :host {
            display: inline-flex;
            width: 1em;
            height: 1em;
            color: currentColor;
            vertical-align: middle;
          }

          svg {
            width: 100%;
            height: 100%;
            stroke: currentColor;
            fill: none;
            stroke-width: 1.9;
            stroke-linecap: round;
            stroke-linejoin: round;
          }
        </style>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 12h14M12 5l7 7-7 7" />
        </svg>
      `;
    }
  }

  customElements.define(tagName, MyMakePhosphorIcon);
}
