"use strict";

// Page-side half of the agent tools: builds the text snapshot of the page and
// performs DOM interactions. Injected on demand into shared tabs only.
//
// Elements the agent may act on get a stable ref ("e12"). Refs stay valid
// across snapshots for as long as the element stays in the document.

(() => {
  if (globalThis.__tabshareAgent) return;

  const refByEl = new WeakMap();
  const elByRef = new Map();
  let refCounter = 0;

  function refFor(el) {
    let ref = refByEl.get(el);
    if (!ref) {
      ref = `e${++refCounter}`;
      refByEl.set(el, ref);
      elByRef.set(ref, new WeakRef(el));
    }
    return ref;
  }

  function byRef(ref) {
    const weak = elByRef.get(ref);
    const el = weak && weak.deref();
    if (!el || !el.isConnected) {
      throw new Error(`Ref ${ref} not found — the page may have changed. Take a new snapshot.`);
    }
    return el;
  }

  function target(params, { optional = false } = {}) {
    if (params.ref) return byRef(params.ref);
    if (params.selector) {
      const el = document.querySelector(params.selector);
      if (!el) throw new Error(`No element matches selector ${params.selector}`);
      return el;
    }
    if (optional) return null;
    throw new Error("Pass either ref (from a snapshot) or selector.");
  }

  // -------------------------------------------------------------------------
  // Snapshot

  const TAG_ROLES = {
    button: "button", summary: "button", select: "combobox", textarea: "textbox",
    h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
    img: "img", svg: "img", canvas: "canvas", video: "video", audio: "audio", iframe: "iframe",
    nav: "navigation", main: "main", header: "banner", footer: "contentinfo", aside: "complementary",
    form: "form", article: "article", dialog: "dialog", details: "group", fieldset: "group",
    table: "table", tr: "row", td: "cell", th: "columnheader", caption: "caption",
    ul: "list", ol: "list", li: "listitem", dl: "list", dt: "term", dd: "definition",
    p: "paragraph", blockquote: "blockquote", pre: "code", hr: "separator",
    figure: "figure", figcaption: "caption", legend: "legend",
    progress: "progressbar", meter: "meter",
  };
  const INPUT_ROLES = {
    checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton", search: "searchbox",
    button: "button", submit: "button", reset: "button", image: "button", file: "filechooser",
  };
  const INTERACTIVE = new Set([
    "link", "button", "textbox", "searchbox", "checkbox", "radio", "combobox", "slider", "spinbutton",
    "filechooser", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "switch", "option", "treeitem",
  ]);
  // Roles whose whole text content becomes the name; children are not walked.
  const NAME_FROM_CONTENT = new Set([
    "link", "button", "heading", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
    "option", "switch", "legend", "caption", "term", "treeitem",
  ]);
  const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "head", "meta", "link", "br", "wbr"]);

  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const q = (s) => JSON.stringify(s);

  function roleOf(el, tag) {
    const explicit = el.getAttribute("role");
    if (explicit && explicit !== "presentation" && explicit !== "none") return explicit.split(" ")[0];
    if (tag === "a") return el.hasAttribute("href") ? "link" : null;
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      return type === "hidden" ? "hidden" : INPUT_ROLES[type] || "textbox";
    }
    if (tag === "section") return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") ? "region" : null;
    return TAG_ROLES[tag] || null;
  }

  function nameOf(el, tag, role) {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const text = labelledby.split(/\s+/).map((id) => {
        const n = document.getElementById(id);
        return n ? n.textContent : "";
      }).join(" ");
      if (clean(text)) return clean(text);
    }
    if (tag === "img") return clean(el.getAttribute("alt") || el.getAttribute("title"));
    if (tag === "input" || tag === "select" || tag === "textarea") {
      if (el.labels && el.labels.length) return clean(el.labels[0].textContent);
      if (tag === "input" && role === "button") return clean(el.value || el.getAttribute("alt"));
      return clean(el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name"));
    }
    if (NAME_FROM_CONTENT.has(role)) {
      const text = clean(el.textContent);
      if (text) return text;
      const img = el.querySelector("img[alt], [aria-label], [title]");
      if (img) return clean(img.getAttribute("alt") || img.getAttribute("aria-label") || img.getAttribute("title"));
    }
    return clean(el.getAttribute("title"));
  }

  function stateOf(el, tag, role) {
    const out = [];
    if (role === "heading") out.push(`level=${el.getAttribute("aria-level") || tag[1] || "?"}`);
    if (role === "checkbox" || role === "radio" || role === "switch") {
      const checked = "checked" in el ? el.checked : el.getAttribute("aria-checked") === "true";
      if (checked) out.push("checked");
    }
    if (el.disabled || el.getAttribute("aria-disabled") === "true") out.push("disabled");
    for (const attr of ["expanded", "selected", "pressed", "current"]) {
      const v = el.getAttribute(`aria-${attr}`);
      if (v && v !== "false") out.push(v === "true" ? attr : `${attr}=${v}`);
    }
    if (tag === "input" || tag === "textarea") {
      if (el.type === "password") { if (el.value) out.push('value="\u2022\u2022\u2022"'); }
      else if (!["checkbox", "radio", "button", "submit", "reset", "file"].includes(el.type) && el.value) {
        out.push(`value=${q(clip(el.value, 200))}`);
      }
      if (el.required) out.push("required");
      if (el.readOnly) out.push("readonly");
    }
    if (tag === "select") {
      const sel = [...el.selectedOptions].map((o) => clean(o.textContent)).join(", ");
      out.push(`value=${q(clip(sel, 200))}`);
    }
    if (role === "link" && el.href) out.push(`url=${clip(el.href, 200)}`);
    if (tag === "iframe") out.push(`src=${clip(el.src || "", 200)}`);
    if (el === document.activeElement) out.push("focused");
    return out;
  }

  function inViewport(rect) {
    return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth
      && rect.width > 1 && rect.height > 1; // 1px boxes are "visually hidden" helpers (skip links)
  }

  const BREAK = { br: true };

  // Adjacent inline text runs are merged, keeping the source's word spacing.
  function pushText(out, raw) {
    const text = clean(raw);
    const last = out[out.length - 1];
    if (last && last.text !== undefined) {
      last.text += (last.trailingSpace || /^\s/.test(raw) ? " " : "") + text;
      last.trailingSpace = /\s$/.test(raw);
    } else {
      out.push({ text, trailingSpace: /\s$/.test(raw) });
    }
  }

  function walkChildren(parent, out, ctx) {
    const root = parent.openOrClosedShadowRoot || parent.shadowRoot;
    const assigned = parent.localName === "slot" ? parent.assignedNodes({ flatten: true }) : [];
    const nodes = root ? root.childNodes : assigned.length ? assigned : parent.childNodes;
    for (const node of nodes) walk(node, out, ctx);
  }

  function walk(node, out, ctx) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = clean(node.nodeValue);
      if (!text) return;
      if (ctx.viewportOnly) {
        const range = document.createRange();
        range.selectNodeContents(node);
        if (!inViewport(range.getBoundingClientRect())) return;
      }
      pushText(out, node.nodeValue);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node;
    const tag = el.localName;
    if (SKIP_TAGS.has(tag) || el.hasAttribute("data-tabshare-overlay")) return;
    if (el.getAttribute("aria-hidden") === "true") return;

    const style = getComputedStyle(el);
    if (style.display === "none") return;
    const invisible = style.visibility !== "visible";
    const inline = style.display.startsWith("inline") || style.display === "contents";

    let role = invisible ? null : roleOf(el, tag);
    if (role === "hidden") return;

    let interactive = INTERACTIVE.has(role);
    if (!invisible && !interactive) {
      const pointer = style.cursor === "pointer"
        && !(el.parentElement && getComputedStyle(el.parentElement).cursor === "pointer");
      if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) {
        role = "textbox";
        interactive = true;
      } else if (pointer || el.hasAttribute("onclick") || (el.tabIndex >= 0 && el.hasAttribute("tabindex"))) {
        role = role || "clickable";
        interactive = true;
      }
    }

    if (!role) {
      if (!inline) out.push(BREAK);
      walkChildren(el, out, ctx);
      if (!inline) out.push(BREAK);
      return;
    }

    // A heading (caption, …) wrapping a link must not swallow it: treat it as
    // a container so the link keeps its own ref.
    const wrapsControls = !interactive && NAME_FROM_CONTENT.has(role)
      && !!el.querySelector("a[href], button, input, select, textarea, [role], [onclick], [tabindex]");
    const leaf = !wrapsControls
      && (NAME_FROM_CONTENT.has(role) || ["select", "svg", "textarea", "iframe", "img"].includes(tag)
        || (role === "textbox" && el.isContentEditable));
    // Only leaves can be judged by their own box; a container may be empty or
    // off-screen itself while its (fixed/absolute) children are visible.
    const offscreen = ctx.viewportOnly && !inViewport(el.getBoundingClientRect());
    if (offscreen && leaf) return;

    const name = wrapsControls ? "" : nameOf(el, tag, role);
    const attrs = stateOf(el, tag, role);
    if (interactive || tag === "iframe") attrs.unshift(`ref=${refFor(el)}`);
    let line = role;
    if (name) line += ` ${q(clip(name, 160))}`;
    for (const a of attrs) line += ` [${a}]`;

    const item = { line, children: [] };
    if (tag === "select") {
      for (const o of [...el.options].slice(0, 40)) {
        item.children.push({
          line: `option ${q(clip(clean(o.textContent), 100))} [value=${q(o.value)}]${o.selected ? " [selected]" : ""}`,
          children: [],
        });
      }
    } else if (role === "textbox" && el.isContentEditable) {
      const text = clean(el.innerText);
      if (text && text !== name) item.children.push({ text: clip(text, 500) });
    } else if (!leaf) {
      walkChildren(el, item.children, ctx);
    }
    // Drop empty structural wrappers (e.g. layout tables, empty lists).
    const meaningful = item.children.some((c) => c !== BREAK);
    if (offscreen && !meaningful) return;
    if (!interactive && !name && !meaningful && !["img", "separator", "iframe", "canvas", "video"].includes(role)) {
      return;
    }
    out.push(item);
  }

  function render(items, depth, lines) {
    const pad = "  ".repeat(depth);
    for (const item of items) {
      if (item === BREAK) continue;
      if (item.text !== undefined) { lines.push(`${pad}- text: ${q(clip(item.text, 800))}`); continue; }
      const kids = item.children.filter((c) => c !== BREAK);
      if (kids.length === 1 && kids[0].text !== undefined) {
        lines.push(`${pad}- ${item.line}: ${q(clip(kids[0].text, 800))}`);
      } else {
        lines.push(`${pad}- ${item.line}${kids.length ? ":" : ""}`);
        render(kids, depth + 1, lines);
      }
    }
  }

  function pageHeader() {
    const doc = document.documentElement;
    const maxY = Math.max(0, doc.scrollHeight - innerHeight);
    const lines = [
      `URL: ${location.href}`,
      `Title: ${document.title}`,
      `Viewport: ${innerWidth}x${innerHeight}, scrollY=${Math.round(scrollY)} of ${maxY}`
        + (maxY ? ` (${Math.round((scrollY / maxY) * 100)}%)` : ""),
    ];
    const selection = clean(String(getSelection()));
    if (selection) lines.push(`Text currently selected by the user: ${q(clip(selection, 2000))}`);
    return lines;
  }

  function snapshot(params) {
    const root = target(params, { optional: true }) || document.body || document.documentElement;
    const items = [];
    walk(root, items, { viewportOnly: !!params.viewportOnly });
    const lines = pageHeader();
    lines.push("");
    render(items, 0, lines);
    return { text: paginate(lines.join("\n"), params) };
  }

  function paginate(text, params, defaultMax = 40000) {
    const offset = Math.max(0, params.offset | 0);
    const max = params.maxChars > 0 ? params.maxChars : defaultMax;
    const slice = text.slice(offset, offset + max);
    const rest = text.length - offset - slice.length;
    return rest > 0
      ? `${slice}\n… [truncated: ${rest} more chars — call again with offset=${offset + max}]`
      : slice;
  }

  // -------------------------------------------------------------------------
  // Actions

  function describe(el) {
    const tag = el.localName;
    const name = nameOf(el, tag, roleOf(el, tag)) || clean(el.textContent);
    return `<${tag}>${name ? ` ${q(clip(name, 60))}` : ""}`;
  }

  function mouseInit(el) {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    return { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0 };
  }

  function coveredNote(el, init) {
    const top = document.elementFromPoint(init.clientX, init.clientY);
    if (!top || top === el || el.contains(top) || top.contains(el)) return "";
    if (top.hasAttribute("data-tabshare-overlay")) return "";
    return ` (note: its centre is covered by ${describe(top)} — the click may not have had the intended effect)`;
  }

  function click(params) {
    const el = target(params);
    const init = mouseInit(el);
    const note = coveredNote(el, init);
    const pointer = { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, buttons: 1 }));
    el.dispatchEvent(new MouseEvent("mousedown", { ...init, buttons: 1 }));
    if (typeof el.focus === "function") el.focus({ preventScroll: true });
    el.dispatchEvent(new PointerEvent("pointerup", pointer));
    el.dispatchEvent(new MouseEvent("mouseup", init));
    if (typeof el.click === "function") el.click();
    else el.dispatchEvent(new MouseEvent("click", init));
    if (params.doubleClick) el.dispatchEvent(new MouseEvent("dblclick", { ...init, detail: 2 }));
    return { text: `Clicked ${describe(el)}${note}` };
  }

  function hover(params) {
    const el = target(params);
    const init = mouseInit(el);
    const pointer = { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true };
    el.dispatchEvent(new PointerEvent("pointerover", pointer));
    el.dispatchEvent(new MouseEvent("mouseover", init));
    el.dispatchEvent(new PointerEvent("pointerenter", { ...pointer, bubbles: false }));
    el.dispatchEvent(new MouseEvent("mouseenter", { ...init, bubbles: false }));
    el.dispatchEvent(new PointerEvent("pointermove", pointer));
    el.dispatchEvent(new MouseEvent("mousemove", init));
    return { text: `Hovering ${describe(el)}` };
  }

  const KEY_CODES = {
    Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, " ": 32,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
    Home: 36, End: 35, PageUp: 33, PageDown: 34,
  };

  // Returns false when a page handler called preventDefault() on keydown.
  function sendKey(el, combo) {
    const parts = combo.split("+");
    let key = parts.pop() || "+";
    if (key === "Space") key = " ";
    const mods = new Set(parts.map((m) => m.toLowerCase()));
    const keyCode = KEY_CODES[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    const code = key.length === 1
      ? (/[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : /\d/.test(key) ? `Digit${key}` : key === " " ? "Space" : "")
      : key;
    const init = {
      key, code, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true,
      ctrlKey: mods.has("control") || mods.has("ctrl"), shiftKey: mods.has("shift"),
      altKey: mods.has("alt"), metaKey: mods.has("meta"),
    };
    const proceed = el.dispatchEvent(new KeyboardEvent("keydown", init));
    if (key.length === 1 || key === "Enter") el.dispatchEvent(new KeyboardEvent("keypress", init));
    el.dispatchEvent(new KeyboardEvent("keyup", init));
    return proceed;
  }

  function submitVia(el) {
    if (!sendKey(el, "Enter")) return;
    if (el.form && el.localName !== "textarea") el.form.requestSubmit();
  }

  function type(params) {
    const el = target(params);
    const text = String(params.text ?? "");
    el.scrollIntoView({ block: "center", behavior: "instant" });
    el.focus({ preventScroll: true });
    if (el.localName === "input" || el.localName === "textarea") {
      // Assigning through the content-script wrapper calls the native setter,
      // so frameworks that shadow `value` (React) still notice the change.
      el.value = params.append ? el.value + text : text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (el.isContentEditable) {
      if (!params.append) document.execCommand("selectAll");
      document.execCommand("insertText", false, text);
    } else {
      throw new Error(`${describe(el)} is not a text field.`);
    }
    if (params.submit) submitVia(el);
    return { text: `Typed into ${describe(el)}${params.submit ? " and pressed Enter" : ""}` };
  }

  function pressKey(params) {
    const el = target(params, { optional: true }) || document.activeElement || document.body;
    if (params.key === "Enter" && (el.localName === "input")) submitVia(el);
    else sendKey(el, String(params.key));
    return { text: `Pressed ${params.key} on ${describe(el)}` };
  }

  function selectOption(params) {
    const el = target(params);
    if (el.localName !== "select") throw new Error(`${describe(el)} is not a <select>.`);
    const wanted = [].concat(params.values ?? params.value ?? []).map(String);
    const chosen = [];
    for (const o of el.options) {
      const hit = wanted.includes(o.value) || wanted.includes(clean(o.textContent));
      if (el.multiple) o.selected = hit;
      else if (hit) o.selected = true;
      if (hit) chosen.push(clean(o.textContent));
    }
    if (!chosen.length) throw new Error(`No option matches ${q(wanted)}.`);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { text: `Selected ${q(chosen)} in ${describe(el)}` };
  }

  function scroll(params) {
    const el = target(params, { optional: true });
    const dir = params.direction;
    if (el && !dir) {
      el.scrollIntoView({ block: "center", behavior: "instant" });
    } else {
      const box = el || window;
      const page = (el ? el.clientHeight : innerHeight) * 0.9 * (params.pages > 0 ? params.pages : 1);
      if (dir === "top") box.scrollTo({ top: 0, behavior: "instant" });
      else if (dir === "bottom") box.scrollTo({ top: (el || document.documentElement).scrollHeight, behavior: "instant" });
      else if (dir === "up") box.scrollBy({ top: -page, behavior: "instant" });
      else if (dir === "down") box.scrollBy({ top: page, behavior: "instant" });
      else throw new Error("Pass direction (up|down|top|bottom) and/or ref/selector.");
    }
    return { text: pageHeader()[2] };
  }

  async function waitFor(params) {
    if (params.seconds > 0) await new Promise((r) => setTimeout(r, Math.min(params.seconds, 30) * 1000));
    const timeout = Math.min(params.timeoutMs > 0 ? params.timeoutMs : 10000, 60000);
    const deadline = Date.now() + timeout;
    const pending = () => {
      const body = document.body ? document.body.innerText : "";
      if (params.text && !body.includes(params.text)) return `text ${q(params.text)} to appear`;
      if (params.textGone && body.includes(params.textGone)) return `text ${q(params.textGone)} to disappear`;
      if (params.selector && !document.querySelector(params.selector)) return `selector ${params.selector}`;
      return null;
    };
    for (;;) {
      const what = pending();
      if (!what) return { text: "Condition met." };
      if (Date.now() > deadline) throw new Error(`Timed out after ${timeout}ms waiting for ${what}.`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  function getText(params) {
    const el = target(params, { optional: true }) || document.body;
    return { text: paginate(el.innerText || el.textContent || "", params) };
  }

  function getHtml(params) {
    const el = target(params, { optional: true }) || document.documentElement;
    return { text: paginate(el.outerHTML, params) };
  }

  function metrics() {
    const doc = document.documentElement;
    return { pageWidth: doc.scrollWidth, pageHeight: doc.scrollHeight, width: innerWidth, height: innerHeight };
  }

  const OPS = {
    ping: () => ({ text: "ok" }),
    metrics, snapshot, click, hover, type, scroll,
    press_key: pressKey, select_option: selectOption, wait_for: waitFor,
    get_text: getText, get_html: getHtml,
  };

  async function handle(op, params) {
    const fn = OPS[op];
    if (!fn) return { error: `Unknown page operation: ${op}` };
    try {
      return await fn(params || {});
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  }

  globalThis.__tabshareAgent = { handle, byRef };

  if (typeof browser !== "undefined" && browser.runtime && browser.runtime.onMessage) {
    browser.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.target !== "agent") return undefined;
      return handle(msg.op, msg.params);
    });
  }
})();
