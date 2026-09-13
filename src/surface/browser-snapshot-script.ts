/**
 * Runs *inside the page* via `page.evaluate`. Deliberately framework-free and dependency-free
 * (no imports) since Playwright serializes this function and executes it in the browser context.
 *
 * What it does, and why:
 *  1. Finds interactive controls (links/buttons/inputs/selects/textareas/ARIA-role widgets) plus
 *     a small set of informative text nodes (headings, alerts) — the pruning keeps the
 *     observation small enough to be cheap and legible for the LLM, per §3.1's "observe" step.
 *  2. For each, computes role/accessible-name/testId/text/a structural CSS path — the same raw
 *     ingredients `buildLocatorSpec` (src/surface/locator.ts) turns into a robust, replayable
 *     locator later. This surface module never decides *which* strategy is best; it only reports
 *     what's observable, honestly, for a given element.
 *  3. Stamps a `data-cua-ref` attribute on each node. This ref is only ever used within the
 *     current live page (discovery-time action resolution, always exact) — it is NOT persisted
 *     into artifacts and NOT relied upon at replay time. Replay resolves elements exclusively via
 *     the recorded LocatorSpec fallback chain against a freshly loaded page.
 */
export interface RawSnapshotNode {
  ref: string;
  role: string;
  name?: string;
  text?: string;
  value?: string;
  testId?: string;
  cssPath: string;
  disabled?: boolean;
}

export function collectSnapshotNodes(maxNodes: number): RawSnapshotNode[] {
  const results: RawSnapshotNode[] = [];
  const seen = new Set<Element>();
  let counter = 0;

  function isVisible(el: Element): boolean {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (parseFloat(style.opacity || "1") === 0) return false;
    return true;
  }

  function cssPath(el: Element): string {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node.nodeType === 1 && parts.length < 8) {
      if (node.id) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      let selector = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      if (parent) {
        const sameTagSiblings = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
        if (sameTagSiblings.length > 1) {
          selector += `:nth-of-type(${sameTagSiblings.indexOf(node) + 1})`;
        }
      }
      parts.unshift(selector);
      node = parent;
    }
    return parts.join(" > ");
  }

  function accessibleName(el: Element): string | undefined {
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel?.trim()) return ariaLabel.trim();

    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const ref = document.getElementById(labelledBy);
      if (ref?.textContent?.trim()) return ref.textContent.trim();
    }

    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const inputType = (el as HTMLInputElement).type;
      // For submit/button-type inputs, the visible label IS the `value` attribute — there is no
      // text content to fall back on since these elements are self-closing.
      if (inputType === "submit" || inputType === "button") {
        const value = el.getAttribute("value");
        if (value?.trim()) return value.trim();
      }
      const id = el.getAttribute("id");
      if (id) {
        const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (label?.textContent?.trim()) return label.textContent.trim();
      }
      const placeholder = el.getAttribute("placeholder");
      if (placeholder?.trim()) return placeholder.trim();
    }

    const alt = el.getAttribute("alt");
    if (alt?.trim()) return alt.trim();
    const title = el.getAttribute("title");
    if (title?.trim()) return title.trim();

    const text = (el.textContent || "").trim().replace(/\s+/g, " ");
    if (text && text.length <= 120) return text;
    return undefined;
  }

  function roleOf(el: Element): string {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "input") {
      const type = (el as HTMLInputElement).type;
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button") return "button";
      return "textbox";
    }
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    return "generic";
  }

  function pushNode(el: Element): void {
    if (results.length >= maxNodes) return;
    if (seen.has(el)) return;
    if (!isVisible(el)) return;
    seen.add(el);

    const ref = `e${++counter}`;
    el.setAttribute("data-cua-ref", ref);

    const testId =
      el.getAttribute("data-testid") ??
      el.getAttribute("data-test") ??
      el.getAttribute("data-qa") ??
      undefined;
    const rawText = (el.textContent || "").trim().replace(/\s+/g, " ");

    results.push({
      ref,
      role: roleOf(el),
      name: accessibleName(el),
      text: rawText && rawText.length <= 200 ? rawText : undefined,
      value: (el as HTMLInputElement).value || undefined,
      testId,
      cssPath: cssPath(el),
      disabled: (el as HTMLButtonElement).disabled || undefined,
    });
  }

  const INTERACTIVE_SELECTOR =
    'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [onclick]';
  const TEXT_SELECTOR = 'h1, h2, h3, h4, h5, h6, [role="alert"]';

  document.querySelectorAll(INTERACTIVE_SELECTOR).forEach((el) => pushNode(el));
  document.querySelectorAll(TEXT_SELECTOR).forEach((el) => pushNode(el));

  return results;
}
