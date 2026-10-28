/* Muse Chrome Bridge v2 — pure rules (no chrome.* calls), unit-tested in Node.
 * Loaded into the service worker with importScripts, and required by tests. */
(function (root) {
  "use strict";

  function hostOf(url) {
    try { return new URL(url).host.toLowerCase(); } catch (e) { return ""; }
  }

  function isWebUrl(url) {
    try { const u = new URL(url); return u.protocol === "http:" || u.protocol === "https:"; }
    catch (e) { return false; }
  }

  // Labels that mean money moves, something is sent or ordered, or something
  // is destroyed: always ask, even on a permitted site. Unicode-aware word
  // edges. Not exhaustive: unlabeled controls in password/payment forms and
  // anything inside a cross-site frame ask as well (see classifyTarget).
  const RISK_WORDS = [
    // English
    "pay", "pay now", "payment", "buy", "buy now", "purchase", "order", "place order", "checkout", "check out",
    "confirm", "complete purchase", "complete order", "send", "send money", "transfer", "wire", "withdraw",
    "donate", "subscribe", "upgrade", "renew", "book", "book now", "reserve", "rent", "bid", "sell",
    "trade", "invest", "publish", "delete", "remove", "erase", "destroy", "discard", "wipe", "empty trash",
    "close account", "deactivate", "terminate", "revoke",
    "cancel subscription", "cancel order", "cancel account", "cancel membership", "cancel plan",
    "cancel booking", "cancel reservation", "cancel payment",
    // Spanish, French, German, Italian, Dutch, Portuguese (common verbs only)
    "pagar", "comprar", "pedido", "eliminar", "borrar", "enviar", "transferir",
    "payer", "acheter", "commander", "supprimer", "envoyer", "virement",
    "bezahlen", "kaufen", "bestellen", "löschen", "senden", "überweisen",
    "paga", "acquista", "ordina", "elimina", "invia",
    "betalen", "kopen", "verwijderen", "verzenden",
    "excluir", "apagar",
  ];
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
  // Common look-alike letters (Cyrillic/Greek homoglyphs) folded to the
  // ASCII letter they render as. A page can render "Pay" with a Cyrillic
  // a so it reads as "Pay" to a person but never matches the ASCII word
  // list; fold those letters back to ASCII before matching. The map
  // covers every Cyrillic/Greek letter whose glyph is a Latin look-alike,
  // in both cases where the glyphs differ. Case-sensitive calls: Cyrillic
  // y is "y" (a fully-Cyrillic pay label folds to "pay"), while Greek
  // lowercase upsilon is "u" (so the same letter in a buy/purchase label
  // folds to "buy" / "purchase") and Greek capital upsilon stays "Y";
  // Greek eta is n-shaped (capital H-shaped), Greek mu is u-shaped
  // (capital M-shaped), and Cyrillic en is H-shaped (Greek nu is N).
  const HOMOGLYPHS = {
    "\u0430": "a", "\u0410": "A", "\u03B1": "a", "\u0391": "A",
    "\u0432": "b", "\u0412": "B", "\u03B2": "b", "\u0392": "B",
    "\u0441": "c", "\u0421": "C", "\u03F2": "c", "\u03F9": "C",
    "\u0435": "e", "\u0415": "E", "\u03B5": "e", "\u0395": "E",
    "\u03F5": "e", "\u041D": "h", "\u043D": "h", "\u0397": "H",
    "\u0456": "i", "\u0406": "I", "\u03B9": "i", "\u0399": "I",
    "\u0458": "j", "\u0408": "J", "\u043A": "k", "\u041A": "K",
    "\u03BA": "k", "\u039A": "K", "\u043C": "m", "\u041C": "M",
    "\u039C": "M", "\u039D": "N", "\u03B7": "n", "\u043E": "o",
    "\u041E": "O", "\u03BF": "o", "\u039F": "O", "\u0440": "p",
    "\u0420": "P", "\u03C1": "p", "\u03A1": "P", "\u0455": "s",
    "\u0405": "S", "\u0442": "t", "\u0422": "T", "\u03C4": "t",
    "\u03A4": "T", "\u03C5": "u", "\u03BC": "u", "\u03BD": "v",
    "\u0445": "x", "\u0425": "X", "\u03C7": "x", "\u03A7": "X",
    "\u0443": "y", "\u0423": "Y", "\u03A5": "Y", "\u0396": "Z",
  };
  const HOMOGLYPH_RE = new RegExp("[" + Object.keys(HOMOGLYPHS).join("") + "]", "g");
  const foldHomoglyphs = (s) => s.replace(HOMOGLYPH_RE, (ch) => HOMOGLYPHS[ch] || ch);
  // Strip invisible characters before risky-word matching: they render
  // invisibly, so a label read as "Delete" must match the word list even
  // if the page hides characters inside it. That means ALL of: Unicode
  // format chars (category Cf: zero-width spaces, ZWNJ/ZWJ, soft hyphens)
  // and the invisible combining marks (category Mn: U+034F COMBINING
  // GRAPHEME JOINER and the U+FE00-U+FE0F / U+E0100-U+E01EF variation
  // selectors are Mn, not Cf, so a Cf-only strip leaves them inside the
  // word and the match breaks). The word list itself stays fixed; this
  // normalizes what each page sends.
  const cleanCf = (s) => (s || "").normalize("NFKC").replace(/[\p{Cf}\p{Mn}\u2028\u2029]/gu, "");
  // The one normalisation every label goes through before risky-word
  // matching: NFKC first (fullwidth and mathematical-bold look-alikes
  // fold to plain ASCII), strip invisible Cf/Mn chars, fold look-alike
  // letters to ASCII, collapse whitespace, and lowercase (RISK_RE is
  // case-insensitive too; lowercasing here keeps any future
  // case-sensitive use safe).
  const normalizeLabel = (s) => foldHomoglyphs(cleanCf(s || "")).replace(/\s+/g, " ").trim().toLowerCase();
  const RISK_RE = new RegExp("(?<![\\p{L}\\p{N}])(" + RISK_WORDS.map(esc).join("|") + ")(?![\\p{L}\\p{N}])", "iu");
  // Same word list, anchored at the start of a label (after any leading
  // punctuation/bullets): a verb-led long label on a generic element.
  const RISK_START_RE = new RegExp("^[^\\p{L}\\p{N}]*(" + RISK_WORDS.map(esc).join("|") + ")(?![\\p{L}\\p{N}])", "iu");
  // The strong subset of the word list: words and phrases that move
  // money or destroy things and are not ordinary prose. The weak subset
  // (WEAK_WORDS) is common dual-use words -- "order", "send", "book",
  // "remove", and their listed foreign equivalents -- that appear
  // constantly in message previews and list-row prose ("final order ...
  // please send the invoice") without the row itself being a risky
  // action. On a generic (non-action-shaped) element a long text is
  // tested against the strong subset in full, and against the whole
  // list only when it is short or verb-led (see classifyTarget).
  const WEAK_WORDS = new Set([
    "order", "send", "book", "reserve", "rent", "sell", "trade", "confirm", "publish", "remove",
    "upgrade", "renew", "bid", "invest", "discard", "revoke",
    "pedido", "enviar", "commander", "envoyer", "bestellen", "senden", "ordina", "invia",
    "verzenden", "verwijderen",
  ]);
  const STRONG_RE = new RegExp("(?<![\\p{L}\\p{N}])(" +
    RISK_WORDS.filter((w) => !WEAK_WORDS.has(w)).map(esc).join("|") + ")(?![\\p{L}\\p{N}])", "iu");

  // d: the page probe's description of the ACTIONABLE element (the button or
  // link a click activates, not the icon or span inside it), merged with the
  // accessibility name Chrome computes for it (d.axName).
  function classifyTarget(d) {
    if (!d) return { ask: false };
    if (d.crossOriginFrame) {
      return { ask: true, reason: `It is inside a frame from ${d.frameHost || "another site"}, embedded in this page. Muse cannot see what it is.` };
    }
    const words = [d.axName, d.name, d.text, d.label].filter(Boolean).join(" ");
    // Check the FULL label, however long it is (SEC-08): the old gate
    // tested a field only when it was <= 40 chars and <= 6 words, so
    // padding a "Pay" label past 40 chars made the prompt never fire.
    // Every field is normalised first (normalizeLabel) and RISK_RE
    // matches on token boundaries only, so a risky string inside a
    // longer word ("repay", "ordering", "display") does not match.
    //   - The aria-label / name / title (label) and the element name are
    //     an action control's own name: always tested in full.
    //   - The accessibility name (axName) is tested in full only when
    //     it is a control's name: an action accessibility role came
    //     with it, or no role information came at all. When the worker
    //     merged an axName with an empty / non-action axRole, that name
    //     is the accessibility tree's StaticText/image leaf fallback
    //     (sw.js axActionable) -- a fragment of page text, not a control
    //     name -- so it gets the generic-text treatment below, not the
    //     full test. (Treating any axName as proof of an action control
    //     re-opened the 2026-09-27 chat-row false positive in real
    //     merged shapes, where the clicked leaf is a StaticText node.)
    //   - The visible / enclosing-button text (text) is tested in full
    //     when the target is an action control under the probe's own
    //     definition (pageProbe ACT / actionable()): a submit element,
    //     any ACT tag (button, a, input, summary, label, select,
    //     textarea), any action role or accessibility role (the full
    //     ACTION_ROLES set, checkbox/switch/radio included), a probe
    //     report that the element itself matches ACT (d.actionableShape:
    //     span[onclick] and friends, whose tag alone does not say so),
    //     or a target with no tag at all (unknown shape: fail closed).
    //   - For any other element (a generic row or container, e.g. a
    //     chat-list row whose preview is prose, or a styled div the
    //     probe resolved by cursor alone) a long text is not trusted
    //     as a pure label, but it is no longer exempt either: a STRONG
    //     risky token anywhere in it asks (STRONG_RE: pay, payment,
    //     buy, purchase, checkout, transfer, delete, every cancel
    //     phrase, ...), and the old tests still apply to the whole
    //     list -- a short text, or a verb-led long text (a risky phrase
    //     at the very start), asks. Only a weak dual-use token (order,
    //     send, book, ...) in the middle of a long generic text does
    //     not ask on its own: that is the one remaining trade-off the
    //     pinned chat-row case demands, and it cannot occur on any
    //     action-shaped control, where the full list applies.
    const ACTION_TAGS = new Set(["button", "a", "input", "summary", "label", "select", "textarea"]);
    const ACTION_ROLES_HERE = new Set(["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio",
      "tab", "checkbox", "radio", "switch", "option", "treeitem", "textbox", "searchbox", "combobox", "textfield"]);
    const actionShape = !!d.isSubmit || ACTION_TAGS.has(String(d.tag || "").toLowerCase())
      || ACTION_ROLES_HERE.has(String(d.role || "").toLowerCase())
      || ACTION_ROLES_HERE.has(String(d.axRole || "").toLowerCase())
      || d.actionableShape === true || !d.tag;
    const axIsActionName = d.axRole == null || ACTION_ROLES_HERE.has(String(d.axRole).toLowerCase());
    const shortLabel = (n) => !!n && n.length <= 40 && n.split(" ").length <= 6;
    const riskyIn = (t, full) => {
      const n = normalizeLabel(t);
      if (!n) return false;
      if (full) return RISK_RE.test(n);
      return STRONG_RE.test(n) || (shortLabel(n) && RISK_RE.test(n)) || RISK_START_RE.test(n);
    };
    if (riskyIn(d.axName, axIsActionName) || riskyIn(d.name, true) || riskyIn(d.label, true) || riskyIn(d.text, actionShape)) {
      return { ask: true, reason: "It may pay, send, order or delete something." };
    }
    if (d.revealsSecret) return { ask: true, reason: "It may show a hidden password." };
    if (d.isSubmit && (d.formHasPassword || d.formHasPayment)) {
      return { ask: true, reason: `It submits a form with a ${d.formHasPassword ? "password" : "payment"} field.` };
    }
    if (!words.trim() && !d.isField && d.inForm && (d.formHasPassword || d.formHasPayment)) {
      return { ask: true, reason: "It is an unlabeled control in a form with a password or payment field." };
    }
    return { ask: false };
  }
  const classifyClick = classifyTarget; // older name

  // Enter or Space with focus f (from the page probe, mode "focus").
  function classifyActivation(f, key) {
    if (!f || f.kind === "none") return { ask: false };
    if (f.kind === "crossOriginFrame") return { ask: true, reason: `Focus is inside a frame from ${f.frameHost || "another site"}. Muse cannot see what ${key} will do there.` };
    if (f.kind === "unknown") return { ask: true, reason: `Muse cannot see which element has focus, so it cannot tell what ${key} will do.` };
    if (f.actionable) return classifyTarget(f);
    // Click parity for DOM-named controls the probe did not flag
    // actionable: a click classifies the hit element's words whether or
    // not it is a semantic control (classifyTarget on the "point"
    // result), so a focused element that is not a genuine field is
    // classified by its own words too. That covers a styled div-button
    // (pointer cursor, JS key handler) whose name is in its DOM text.
    // A genuine field is an input/textarea/select or a contenteditable
    // element -- a role alone does not make one: a non-editable div with
    // role="textbox" is a disguised control, not a text field, and its
    // words are judged exactly as a click would judge them. Genuine
    // fields skip this and keep the form-submit branch below as their
    // only prompt (SEC-06), so Enter in a field is never double-gated.
    const genuineField = !!f.isContentEditable ||
      ["input", "textarea", "select"].includes(String(f.tag || "").toLowerCase()) ||
      (!f.tag && !!f.isField);
    if (!genuineField) {
      const c = classifyTarget(f);
      if (c.ask) return c;
    }
    if (key === "Enter" && f.isField && f.tag !== "textarea" && !f.isContentEditable && f.inForm &&
        (f.formHasPassword || f.formHasPayment || f.formRiskySubmit)) {
      return { ask: true, reason: `Enter submits a form that ${f.formHasPassword ? "has a password field" : f.formHasPayment ? "has a payment field" : "may pay, send or delete"}.` };
    }
    return { ask: false };
  }

  // Typing characters with focus f: passwords and blind spots ask.
  function classifyTyping(f) {
    if (!f) return { ask: false };
    if (f.kind === "crossOriginFrame") return { ask: true, password: true, reason: `The typing goes into a frame from ${f.frameHost || "another site"}. Muse cannot see if it is a password field.` };
    if (f.kind === "unknown") return { ask: true, password: true, reason: "Muse cannot see which field has focus. It may be a password field." };
    if (f.isPassword) return { ask: true, password: true, reason: "It is a password field." };
    return { ask: false };
  }

  // A field whose own value is secret: it is never shown in a prompt or the
  // audit log. Payment fields count, like password fields.
  function isSecretField(d) {
    return !!(d && (d.isPassword || d.isPayField));
  }

  // Filling a field with form_input (d: the probe's description of the field
  // itself, which carries its form's facts from formFacts). Ask when the
  // field itself is a payment field, when its form holds any payment or
  // password field, or when its form's submit is classified risky. A
  // password field itself also asks, as it always has.
  function classifyFormInput(d) {
    if (!d) return { ask: false, secret: false };
    const secret = isSecretField(d);
    if (d.isPayField) return { ask: true, secret, reason: "It is a payment field." };
    if (d.isPassword) return { ask: true, secret, reason: "It is a password field." };
    if (d.formHasPayment) return { ask: true, secret, reason: "Its form has a payment field." };
    if (d.formHasPassword) return { ask: true, secret, reason: "Its form has a password field." };
    if (d.formRiskySubmit) return { ask: true, secret, reason: "Its form's submit may pay, send, order or delete something." };
    return { ask: false, secret };
  }
  const classifyFormFill = classifyFormInput; // alias

  function clip(s, n) {
    s = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  // Human description of an element for prompts and the audit log.
  // Never includes a password field's value (the probe never returns one).
  function describeTarget(d) {
    if (!d) return "(nothing there)";
    if (d.crossOriginFrame) return `a frame from ${d.frameHost || "another site"}`;
    let s = d.axRole || d.role || d.tag || "element";
    const label = d.axName || d.name || d.text || d.label;
    if (label) s += ` "${clip(label, 60)}"`;
    if (d.isPassword) s += " (password field)";
    if (d.href) { const h = hostOf(d.href); if (h) s += ` → ${h}`; }
    if (d.frameHost) s += ` (in a frame from ${d.frameHost})`;
    return s;
  }

  // What the user sees for typed text. Passwords never show content.
  function shownTyping(text, isPassword) {
    const t = String(text == null ? "" : text);
    if (isPassword) return `(${[...t].length} characters, hidden)`;
    // No length cap: an approval prompt must show the whole value that will
    // be filled, not a clipped preview of it (SEC-06 repair).
    return '"' + t.replace(/\s+/g, " ").trim() + '"';
  }

  // ---- keys -------------------------------------------------------------
  const MODS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, win: 4, windows: 4, shift: 8 };
  const NAMED = {
    enter: ["Enter", "Enter", 13, "\r"], return: ["Enter", "Enter", 13, "\r"],
    tab: ["Tab", "Tab", 9, ""], escape: ["Escape", "Escape", 27, ""], esc: ["Escape", "Escape", 27, ""],
    backspace: ["Backspace", "Backspace", 8, ""], delete: ["Delete", "Delete", 46, ""],
    space: [" ", "Space", 32, " "], up: ["ArrowUp", "ArrowUp", 38, ""], down: ["ArrowDown", "ArrowDown", 40, ""],
    left: ["ArrowLeft", "ArrowLeft", 37, ""], right: ["ArrowRight", "ArrowRight", 39, ""],
    arrowup: ["ArrowUp", "ArrowUp", 38, ""], arrowdown: ["ArrowDown", "ArrowDown", 40, ""],
    arrowleft: ["ArrowLeft", "ArrowLeft", 37, ""], arrowright: ["ArrowRight", "ArrowRight", 39, ""],
    home: ["Home", "Home", 36, ""], end: ["End", "End", 35, ""], pageup: ["PageUp", "PageUp", 33, ""],
    pagedown: ["PageDown", "PageDown", 34, ""],
  };
  for (let i = 1; i <= 12; i++) NAMED["f" + i] = ["F" + i, "F" + i, 111 + i, ""];

  // "ctrl+a Enter Backspace" -> [{key, code, vk, modifiers, text}]
  function parseKeys(spec) {
    const out = [];
    for (const combo of String(spec || "").trim().split(/\s+/).filter(Boolean)) {
      const parts = combo.split("+");
      let modifiers = 0;
      let main = parts.pop();
      if (main === "" && parts.length) { parts.pop(); main = "+"; } // "ctrl++"
      for (const p of parts) {
        const m = MODS[p.toLowerCase()];
        if (m === undefined) throw Object.assign(new Error("bad_key"), { code: "bad_key", detail: combo });
        modifiers |= m;
      }
      const named = NAMED[main.toLowerCase()];
      if (named) {
        out.push({ key: named[0], code: named[1], vk: named[2], modifiers,
                   text: modifiers & (1 | 2 | 4) ? "" : named[3] });
      } else if ([...main].length === 1) {
        const upper = main.toUpperCase();
        const isLetter = /[A-Z]/.test(upper);
        const isDigit = /[0-9]/.test(main);
        out.push({
          key: main, code: isLetter ? "Key" + upper : isDigit ? "Digit" + main : "",
          vk: isLetter || isDigit ? upper.charCodeAt(0) : 0, modifiers,
          text: modifiers & (1 | 2 | 4) ? "" : main,
        });
      } else {
        throw Object.assign(new Error("bad_key"), { code: "bad_key", detail: combo });
      }
    }
    return out;
  }
  // Enter and Space activate the focused control (with any modifiers).
  const isActivationKey = (k) => k.key === "Enter" || k.key === " ";
  // Keys that put characters into a field (Space counts as both).
  const isTypingKey = (k) => !!k.text && k.key !== "Enter";
  const keyName = (k) => (k.key === " " ? "Space" : k.key);

  // Ref ids handed to the agent: "ref_12". Anything else is rejected.
  function parseRef(ref) {
    const m = /^ref_(\d{1,9})$/.exec(String(ref || ""));
    return m ? m[0] : null;
  }

  const INTERACTIVE_ROLES = new Set([
    "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox",
    "menuitem", "menuitemcheckbox", "menuitemradio", "option", "tab", "switch", "slider",
    "spinbutton", "treeitem", "textfield", "gridcell",
  ]);
  // Roles a click or key press activates (for the accessibility cross-check).
  const ACTION_ROLES = new Set([
    "button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "checkbox",
    "radio", "switch", "option", "treeitem", "textbox", "searchbox", "combobox", "textfield",
  ]);

  // Rank tree lines for a natural-language query. lines: [{ref, role, name}]
  // Unicode-aware, so queries in any script work.
  function rankForQuery(lines, query) {
    const words = String(query || "").toLowerCase().split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w && ([...w].length > 1 || /[^\x00-\x7f]/.test(w)));
    if (!words.length) return [];
    const scored = [];
    for (const l of lines) {
      const hay = `${l.role} ${l.name || ""}`.toLowerCase();
      let score = 0;
      for (const w of words) if (hay.includes(w)) score += w.length;
      if (score) scored.push([score, l]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    return scored.slice(0, 20).map((x) => x[1]);
  }

  // ---- text redaction (SEC-04) -------------------------------------------
  // Page text goes straight to a chat, so secrets printed on the page must
  // not ride along. Two narrow rules, both deliberately conservative so
  // ordinary prose and short numbers survive untouched:
  //   - a digit sequence of 13-19 digits (in digit groups joined by single
  //     spaces, hyphens or dots, as cards are usually printed) that passes
  //     the Luhn check becomes "[card-redacted]";
  //   - a base64/hex-looking token of 32+ characters that follows a
  //     key/token/secret label (e.g. "api_key: <token>"; dotted segments
  //     count as one token, so a JWT is hidden whole) becomes
  //     "[secret-redacted]"; the label itself stays.
  // Returns { text, redactions } so callers can report how much was hidden.
  function luhnValid(digits) {
    let sum = 0, dbl = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = digits.charCodeAt(i) - 48;
      if (d < 0 || d > 9) return false;
      if (dbl) { d *= 2; if (d > 9) d -= 9; }
      sum += d; dbl = !dbl;
    }
    return digits.length > 0 && sum % 10 === 0;
  }
  // A run of digit groups joined by single spaces, hyphens or dots. The
  // run is scanned group by group instead of being matched as a whole:
  // a card printed beside other numbers ("4111111111111111 5 items",
  // "page 2 4111 1111 1111 1111", two cards one space apart) must still be
  // caught, so groups are accumulated until they hold 13-19 digits and
  // the Luhn check decides. A group that cannot belong to a card is
  // skipped, not fatal, and digits outside a Luhn-valid span of 13-19 are
  // left exactly as they are (so a 20+ digit run, or a non-Luhn 16-digit
  // number in 4-groups whose only in-range span is the whole number,
  // survives untouched).
  const CARD_RUN_RE = /\d+(?:[ .-]\d+)*/g;
  function redactCards(text, count) {
    return text.replace(CARD_RUN_RE, (run) => {
      const groups = [];
      const GROUP_RE = /\d+/g;
      let gm;
      while ((gm = GROUP_RE.exec(run)) !== null)
        groups.push({ start: gm.index, end: gm.index + gm[0].length, digits: gm[0] });
      let total = 0;
      for (const g of groups) total += g.digits.length;
      if (total < 13) return run;
      let out = "", cursor = 0, i = 0;
      while (i < groups.length) {
        let digits = 0, hit = -1;
        for (let j = i; j < groups.length; j++) {
          digits += groups[j].digits.length;
          if (digits > 19) break;
          if (digits >= 13 && luhnValid(groups.slice(i, j + 1).map((g) => g.digits).join(""))) { hit = j; break; }
        }
        if (hit < 0) { i++; continue; }
        out += run.slice(cursor, groups[i].start) + "[card-redacted]";
        cursor = groups[hit].end;
        i = hit + 1;
        count.n++;
      }
      return cursor ? out + run.slice(cursor) : run;
    });
  }
  // Label: a word containing key/token/secret, optionally quoted or
  // wrapped in brackets, then a separator -- ":" or "=" (spaces allowed),
  // the word "is", or plain whitespace -- and an optional opening quote.
  // The token is base64/hex characters in dot-joined segments, so a JWT
  // after a label is matched whole; its 32+ length is checked in the
  // callback because a segment count cannot be totalled in the pattern,
  // and a short value after a label is left alone.
  const LABELLED_TOKEN_RE = /((?<![A-Za-z0-9_-])["'(\[]?[\w-]*(?:key|token|secret)[\w-]*["'\])]?\s*(?:[:=]\s*|\s+is\s+|\s+)["']?)([A-Za-z0-9+/=_-]+(?:\.[A-Za-z0-9+/=_-]+)*)/gi;
  function redactText(input) {
    const count = { n: 0 };
    let text = String(input == null ? "" : input);
    text = redactCards(text, count);
    text = text.replace(LABELLED_TOKEN_RE, (m, label, token) => {
      if (token.length < 32) return m;
      count.n++;
      return label + "[secret-redacted]";
    });
    return { text, redactions: count.n };
  }

  /* ---- page probe ------------------------------------------------------
   * Runs INSIDE the page, in an isolated world (page scripts cannot change
   * what it sees). Self-contained: no references to anything outside it.
   * The service worker passes it as source text. Every mode returns
   * {host, v}: host is the page's host at the moment it ran, so the worker
   * can refuse a result that came from a document it has not permitted.
   *   "point"    {x,y}  the actionable element under a viewport point,
   *                     looking through open shadow roots and same-origin
   *                     frames; cross-origin frames are reported as such.
   *   "refpoint" {x,y}  the same, with this = the ref's node; adds
   *                     covered:true when the point hits something else.
   *   "node"            this = a node; the element itself (for fields).
   *   "focus"           the element with keyboard focus, same rules.
   *   "fields"          form field values, secret fields hidden. Entries
   *                     also carry the probe's own isPassword / isPayField
   *                     classification and the autocomplete value, so a
   *                     caller never has to re-guess a field's kind from
   *                     its name alone. No count cap: a cap would let a
   *                     page hide a sensitive field behind padding fields.
   *   "shotcheck"       {password, payment, crossOriginFrame, fieldCount}
   *                     for the screenshot gate: the same classifications,
   *                     computed in-page over EVERY field (no cap).
   *   "text"            the page's main text.
   *   "tree"            this frame's OWN element tree (the all-frames
   *                     read: the worker runs it in every frame of the
   *                     tab and stitches the results). Entries carry
   *                     role and name in the tree builder's shape plus
   *                     describe()'s classification facts — the
   *                     protections' own classifier, never a second
   *                     one — and each element's centre in THIS frame's
   *                     viewport coordinates. The elements themselves
   *                     are stashed on the window under a.build for
   *                     "measure".
   *   "measure"         {build, i}: scroll the stashed element into
   *                     view and report its fresh centre, its checked
   *                     state, and its describe() facts.
   *   "frames"          this document's iframe elements with their
   *                     rects, so the worker can add up frame offsets.
   * It never returns the value of a password field. */
  function pageProbe(mode, a) {
    a = a || {};
    const RISK = new RegExp(a.risk[0], a.risk[1]);
    const PAY = /(^|[^a-z])(cc[-_ ]?(number|num|csc|cvc|exp)|card.?(number|num|no)|cardnumber|cvv|cvc|csc|security.?code|iban|account.?number|routing|expir|exp[-_ ]?(date|month|year))/i;
    const REVEAL = /(show|reveal|unmask|view|display|toggle)\W{0,3}(\w+\W{1,3})?(password|passcode|passwort|contraseña|mot de passe|pin|pwd)/i;
    // Same normalisation as the worker (the probe is self-contained, so
    // it carries its own copy; page scripts cannot see or change it):
    // NFKC, strip invisible Cf/Mn chars, and fold Cyrillic/Greek
    // look-alikes to ASCII, so a look-alike submit label is still risky.
    const HG = {
      "\u0430": "a", "\u0410": "A", "\u03B1": "a", "\u0391": "A",
      "\u0432": "b", "\u0412": "B", "\u03B2": "b", "\u0392": "B",
      "\u0441": "c", "\u0421": "C", "\u03F2": "c", "\u03F9": "C",
      "\u0435": "e", "\u0415": "E", "\u03B5": "e", "\u0395": "E",
      "\u03F5": "e", "\u041D": "h", "\u043D": "h", "\u0397": "H",
      "\u0456": "i", "\u0406": "I", "\u03B9": "i", "\u0399": "I",
      "\u0458": "j", "\u0408": "J", "\u043A": "k", "\u041A": "K",
      "\u03BA": "k", "\u039A": "K", "\u043C": "m", "\u041C": "M",
      "\u039C": "M", "\u039D": "N", "\u03B7": "n", "\u043E": "o",
      "\u041E": "O", "\u03BF": "o", "\u039F": "O", "\u0440": "p",
      "\u0420": "P", "\u03C1": "p", "\u03A1": "P", "\u0455": "s",
      "\u0405": "S", "\u0442": "t", "\u0422": "T", "\u03C4": "t",
      "\u03A4": "T", "\u03C5": "u", "\u03BC": "u", "\u03BD": "v",
      "\u0445": "x", "\u0425": "X", "\u03C7": "x", "\u03A7": "X",
      "\u0443": "y", "\u0423": "Y", "\u03A5": "Y", "\u0396": "Z",
    };
    const HG_RE = new RegExp("[" + Object.keys(HG).join("") + "]", "g");
    const cleanCf = (s) => (s || "").normalize("NFKC").replace(/[\p{Cf}\p{Mn}\u2028\u2029]/gu, "")
      .replace(HG_RE, (ch) => HG[ch] || ch);
    const ACT = 'a[href],button,summary,select,textarea,input,label,[role=button],[role=link],[role=menuitem],' +
      '[role=menuitemcheckbox],[role=menuitemradio],[role=tab],[role=checkbox],[role=radio],[role=switch],' +
      '[role=option],[onclick],[contenteditable=""],[contenteditable="true"]';
    const hostOf = (u) => { try { return new URL(u, location.href).host.toLowerCase(); } catch (e) { return ""; } };
    const isEl = (n) => !!n && n.nodeType === 1;
    // Parent across shadow roots and same-origin frame boundaries.
    const up = (n) => {
      if (n.parentElement) return n.parentElement;
      const r = n.getRootNode && n.getRootNode();
      if (r && r !== n && r.host) return r.host;
      if (r && r.nodeType === 9) { try { return r.defaultView && r.defaultView.frameElement; } catch (e) { return null; } }
      return null;
    };
    const style = (el) => { try { return el.ownerDocument.defaultView.getComputedStyle(el); } catch (e) { return null; } };
    function actionable(el) {
      let n = el;
      for (let i = 0; n && i < 40; i++) { if (isEl(n) && n.matches(ACT)) return n; n = up(n); }
      // No semantic control: a styled clickable (div with a JS handler). Take
      // the outermost ancestor that still shows the pointer cursor.
      const s0 = style(el);
      if (!s0 || s0.cursor !== "pointer") return el;
      let best = el; n = up(el);
      for (let i = 0; n && i < 15; i++) { const s = style(n); if (!s || s.cursor !== "pointer") break; best = n; n = up(n); }
      return best;
    }
    const attr = (el, k) => (el.getAttribute && el.getAttribute(k)) || "";
    const typeOf = (el) => attr(el, "type").toLowerCase();
    function txt(el) {
      const parts = [];
      const lab = attr(el, "aria-labelledby");
      if (lab) for (const id of lab.split(/\s+/)) { const r = el.ownerDocument.getElementById(id); if (r) parts.push(r.textContent || ""); }
      parts.push(attr(el, "aria-label"), attr(el, "title"));
      parts.push(el.innerText || el.textContent || "");
      if (el.querySelectorAll) for (const im of el.querySelectorAll("img[alt],[aria-label],svg title")) {
        parts.push(im.getAttribute("alt") || im.getAttribute("aria-label") || im.textContent || "");
      }
      if (el.shadowRoot) parts.push(el.shadowRoot.textContent || "");
      return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 300);
    }
    // The field's visible label text: its <label> element(s) (by `for`, by
    // wrapping, or via el.labels), plus aria-labelledby targets. Pages often
    // identify a field ONLY here (name/id are opaque like "f1"), so isPwd /
    // isPay must read it. Every lookup is guarded: a partial DOM (or a shim)
    // that lacks one channel just contributes nothing.
    function labelText(el) {
      const parts = [];
      try { if (el.labels) for (const l of el.labels) parts.push(l.textContent || ""); } catch (e) {}
      try { const w = el.closest && el.closest("label"); if (w) parts.push(w.textContent || ""); } catch (e) {}
      for (let n = up(el), i = 0; n && i < 10; i++, n = up(n)) if (n.tagName === "LABEL") parts.push(n.textContent || "");
      const lb = attr(el, "aria-labelledby");
      if (lb) for (const id of lb.split(/\s+/)) { try { const r = el.ownerDocument.getElementById(id); if (r) parts.push(r.textContent || ""); } catch (e) {} }
      const id = el.id || attr(el, "id");
      if (id) {
        try { const doc = el.ownerDocument; if (doc && doc.querySelectorAll) for (const l of doc.querySelectorAll("label")) if ((l.htmlFor || attr(l, "for")) === id) parts.push(l.textContent || ""); } catch (e) {}
        // Tree walk from the topmost ancestor: finds a <label for> even when
        // the document offers no label query (and never trusts attributes of
        // the input itself for this).
        let top = el;
        for (let n = up(el), i = 0; n && i < 50; i++, n = up(n)) top = n;
        const stack = [top], seen = new Set();
        while (stack.length) {
          const n = stack.pop();
          if (!n || seen.has(n)) continue;
          seen.add(n);
          if (n.tagName === "LABEL" && (attr(n, "for") === id || n.htmlFor === id)) parts.push(n.textContent || "");
          for (const c of n.children || []) stack.push(c);
          if (n.shadowRoot) for (const c of n.shadowRoot.children || []) stack.push(c);
        }
      }
      // The scans above can find the same <label> up to three times
      // (el.labels, a document scan, a tree walk). For classification
      // the repeats were harmless; as a field's NAME they multiply
      // ("Note Note Note"), so identical parts are kept once.
      const uniq = [];
      for (const p of parts) { const t = (p || "").replace(/\s+/g, " ").trim(); if (t && !uniq.includes(t)) uniq.push(t); }
      return uniq.join(" ");
    }
    // Visit every element under root, piercing open shadow roots and
    // same-origin frames (querySelectorAll alone does neither). Cross-origin
    // frame contents stay unreachable by design; formFacts treats the frame
    // element itself as the signal there.
    function deepEach(root, fn) {
      const seen = new Set();
      const walk = (n) => {
        if (!n || seen.has(n)) return;
        seen.add(n);
        if (isEl(n)) {
          fn(n);
          if (/^(IFRAME|FRAME)$/.test(n.tagName)) {
            try { const d = n.contentDocument; if (d && d.documentElement) walk(d.documentElement); } catch (e) {}
          }
        }
        for (const c of n.children || n.childNodes || []) walk(c);
        if (n.shadowRoot) for (const c of n.shadowRoot.children || n.shadowRoot.childNodes || []) walk(c);
      };
      walk(root);
    }
    function isPwd(el) {
      if (!isEl(el) || el.tagName !== "INPUT") return false;
      const t = typeOf(el);
      if (t === "password") return true;
      if (["hidden", "checkbox", "radio", "submit", "button", "reset", "image", "file", "range", "color"].includes(t)) return false;
      const ac = attr(el, "autocomplete").toLowerCase();
      if (/current-password|new-password|password|one-time-code/.test(ac)) return true;
      const s = style(el);
      if (s && s.webkitTextSecurity && s.webkitTextSecurity !== "none") return true;
      // A reveal toggle flips type=password to type=text, so the type alone
      // cannot be trusted: the name/id and the form context still identify
      // the field. "secret" is covered on its own; "pin" counts in a form
      // that also holds a real type=password field. The label text and
      // aria-label/placeholder are tested too: a field labelled "Password"
      // is a password field whatever its name says.
      const nameId = ((el.name || "") + " " + (el.id || "")).replace(/([a-z0-9])([A-Z])/g, "$1 $2");
      if (/pass|pwd|secret/i.test(nameId)) return true;
      if (/pass|pwd|secret|pin/i.test(nameId)) {
        const form = el.form || (el.closest && el.closest("form"));
        if (form && form.querySelectorAll) {
          try {
            for (const f of form.querySelectorAll("input")) {
              if (f !== el && typeOf(f) === "password") return true;
            }
          } catch (e) {}
        }
      }
      return /pass(word|wd|code)?|pwd|(^|[^a-z])(totp|pin|otp)([^a-z]|$)/i.test(
        nameId + " " + labelText(el) + " " + attr(el, "aria-label") + " " + attr(el, "placeholder"));
    }
    function isPay(el) {
      if (!isEl(el)) return false;
      if (/(^|\s)cc-/.test(attr(el, "autocomplete").toLowerCase())) return true;
      if (!/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return false;
      if (PAY.test([el.name, el.id, attr(el, "placeholder"), attr(el, "aria-label")].join(" "))) return true;
      // Label wording is looser than name/id wording: "Card number", or a
      // placeholder like "Long number on the front of the card", names a
      // payment field even with no adjacent card+number pair.
      return /(card|cvv|cvc|csc|security.?code|iban|account.?number|routing|expir)/i.test(
        labelText(el) + " " + attr(el, "placeholder") + " " + attr(el, "aria-label"));
    }
    const allFields = (root) => {
      let base = [];
      try { base = [...root.querySelectorAll("input,select,textarea")]; } catch (e) {}
      const seen = new Set(base), out = [...base];
      deepEach(root, (el) => {
        if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && !seen.has(el)) { seen.add(el); out.push(el); }
      });
      return out;
    };
    // Every button-like control under root, same deep traversal: real
    // buttons, [role=button] controls, and submit/button/image inputs,
    // wherever they sit. input[type=image] is a submit element per
    // isSubmitEl, and input[type=button] is the JS-driven analogue of
    // <button type="button">; btnWords/classifyTarget already treat
    // both as risky controls, so formFacts must see them too.
    const deepButtons = (root) => {
      let base = [];
      try { base = [...root.querySelectorAll('button,[role=button],input[type=submit],input[type=image],input[type=button]')]; } catch (e) {}
      const seen = new Set(base), out = [...base];
      deepEach(root, (el) => {
        if ((el.tagName === "BUTTON" || attr(el, "role") === "button" ||
             (el.tagName === "INPUT" && ["submit", "image", "button"].includes(typeOf(el)))) && !seen.has(el)) { seen.add(el); out.push(el); }
      });
      return out;
    };
    // A frame inside the group: payment fields increasingly live in one
    // (Stripe-Elements-style), and a cross-origin frame's contents cannot be
    // inspected at all, so the frame itself counts. In a real <form> any
    // embedded frame counts; outside one, only a payment-looking frame does.
    const hasFrame = (root, anyFrame) => {
      let found = false;
      deepEach(root, (el) => {
        if (found || !/^(IFRAME|FRAME)$/.test(el.tagName)) return;
        if (anyFrame || /(stripe|paypal|checkout|payment|card|billing|secure)/i.test(
            (el.src || attr(el, "src")) + " " + (el.name || "") + " " + (el.id || ""))) found = true;
      });
      return found;
    };
    // Every field the page holds, not just the top document's: walk open
    // shadow roots and same-origin frame documents recursively (depth-capped
    // against self-nesting frames). A cross-origin frame's document cannot
    // be read from here at all, so it is reported instead: whatever fields
    // it holds (a hosted payment frame is the common case) are invisible to
    // every in-page check, and a caller that photographs the page must
    // treat that frame's presence as unknown-sensitive, not as clean.
    // Closed shadow roots are not reachable from page JS (el.shadowRoot
    // is null); the worker covers those through the CDP DOM tree instead.
    function deepScan() {
      const fields = [];
      let crossOriginFrame = false;
      const seen = new Set();
      const walk = (root, depth) => {
        if (!root || seen.has(root) || depth > 10) return;
        seen.add(root);
        try { for (const e of root.querySelectorAll("input,select,textarea")) fields.push(e); } catch (e) {}
        let all = [];
        try { all = [...root.querySelectorAll("*")]; } catch (e) {}
        for (const el of all) {
          try { if (el.shadowRoot) walk(el.shadowRoot, depth + 1); } catch (e) {}
          if (/^(IFRAME|FRAME)$/.test(el.tagName || "")) {
            const fi = frameInfo(el);
            if (fi.crossOrigin) {
              let hidden = false;
              try { const s = style(el); if (s && (s.display === "none" || s.visibility === "hidden")) hidden = true; } catch (e) {}
              if (!hidden) crossOriginFrame = true;
            } else if (fi.doc) walk(fi.doc, depth + 1);
          }
        }
      };
      walk(document, 0);
      return { fields, crossOriginFrame };
    }
    function isSubmitEl(el) {
      const t = typeOf(el);
      return (el.tagName === "BUTTON" && (t === "" || t === "submit")) || (el.tagName === "INPUT" && (t === "submit" || t === "image"));
    }
    const btnWords = (b) => b.tagName === "INPUT" ? (b.value || attr(b, "alt")) : txt(b);
    // The form an element belongs to; for script-driven pages with no <form>,
    // the nearest ancestor (up to 4 levels) holding a password field, a
    // payment field or a risky button.
    function groupOf(el) {
      const f = el.form || (el.closest && el.closest("form"));
      if (f) return { root: f, isForm: true };
      let n = up(el);
      // 20 levels, not 4: script-driven checkouts nest fields deep, and the
      // common ancestor holding the payment field is the group that matters.
      for (let i = 0; n && i < 20 && n.tagName !== "BODY"; i++, n = up(n)) {
        const fs = allFields(n);
        if (fs.some(isPwd) || fs.some(isPay) || hasFrame(n, false)) return { root: n, isForm: false };
        if (deepButtons(n).some((b) => RISK.test(cleanCf(btnWords(b))))) return { root: n, isForm: false };
      }
      return null;
    }
    function formFacts(el) {
      const g = groupOf(el);
      if (!g) return { inForm: false, formHasPassword: false, formHasPayment: false, formRiskySubmit: false };
      const fields = allFields(g.root);
      // The submit set is the same for a real <form> as for a script-driven
      // group: JS checkouts submit from <button type="button"> or a
      // [role=button] div, and classifyTarget already calls those risky.
      // Filtering a real form to submit elements only missed exactly them.
      const subs = deepButtons(g.root);
      return {
        inForm: true, formHasPassword: fields.some(isPwd),
        formHasPayment: fields.some(isPay) || hasFrame(g.root, g.isForm),
        formRiskySubmit: subs.some((b) => RISK.test(cleanCf(btnWords(b)))),
      };
    }
    function describe(el, frameHost) {
      const t = typeOf(el);
      const pwd = isPwd(el);
      const btnInput = el.tagName === "INPUT" && ["submit", "button", "reset", "image"].includes(t);
      const field = !btnInput && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !!el.isContentEditable);
      const text = pwd || field ? "" : btnInput ? (el.value || attr(el, "alt")) : txt(el);
      const label = (labelText(el) || attr(el, "aria-label") || attr(el, "placeholder") || attr(el, "name") || attr(el, "title")).slice(0, 120);
      const link = el.closest ? el.closest("a[href]") : null;
      const tag = el.tagName.toLowerCase();
      const role = attr(el, "role").toLowerCase();
      const href = link ? link.href : "";
      const facts = formFacts(el);
      const ctl = attr(el, "aria-controls") && el.ownerDocument.getElementById(attr(el, "aria-controls"));
      let actionableShape = false; try { actionableShape = !!el.matches(ACT); } catch (e) {}
      const revealsSecret = !field && (REVEAL.test(cleanCf(text + " " + label)) || (!!ctl && isPwd(ctl)));
      const form = el.form || (el.closest && el.closest("form"));
      return Object.assign({
        tag, role, type: t, text, label, href, autocomplete: attr(el, "autocomplete"), isPassword: pwd, isField: field, isPayField: isPay(el),
        isContentEditable: !!el.isContentEditable, actionableShape, isSubmit: isSubmitEl(el), revealsSecret, frameHost: frameHost || "",
        fp: [tag, role, t, text.slice(0, 80), label, attr(el, "autocomplete"), href, (form && form.action) || "", frameHost || ""].join("|"),
      }, facts);
    }
    function deepAt(doc, x, y) {
      let el = doc.elementFromPoint(x, y);
      for (let i = 0; el && el.shadowRoot && i < 20; i++) {
        const inner = el.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === el) break;
        el = inner;
      }
      return el;
    }
    function frameInfo(el) {
      let d = null;
      try { d = el.contentDocument; } catch (e) { d = null; }
      if (d && d.documentElement) return { doc: d };
      return { crossOrigin: true, host: hostOf(el.src || attr(el, "src")) || "(unknown)" };
    }
    // Innermost element at a viewport point, through same-origin frames.
    function hitAt(x, y) {
      let doc = document, fh = "";
      if (!(x >= 0 && y >= 0 && x < innerWidth && y < innerHeight)) return { offscreen: true };
      let el = deepAt(doc, x, y);
      for (let i = 0; el && /^(IFRAME|FRAME)$/.test(el.tagName) && i < 10; i++) {
        const fi = frameInfo(el);
        if (fi.crossOrigin) return { el, crossOrigin: true, frameHost: fi.host };
        const r = el.getBoundingClientRect();
        x -= r.left + el.clientLeft; y -= r.top + el.clientTop;
        doc = fi.doc; fh = hostOf(doc.location.href);
        el = deepAt(doc, x, y);
      }
      return { el, frameHost: fh };
    }
    function related(a, b) { // a is b, or an ancestor of b, across shadow/frame boundaries
      for (let n = b, i = 0; n && i < 200; i++, n = up(n)) if (n === a) return true;
      return false;
    }
    // ---- the all-frames tree (modes "tree" / "measure" / "frames") ----
    // Claude in Chrome builds its element tree inside every frame (a
    // content script registered for all frames); the bridge runs the
    // same builder per frame through scripting instead. A frame reports
    // only its OWN document — it never reaches across a frame boundary.
    // Role and name follow the tree builder's shape; every classification
    // fact comes from describe() above, so a framed field is judged by
    // exactly the rules a top-frame field is judged by.
    const ROLE_BY_TAG = (el) => {
      const t = el.tagName;
      if (t === "A") return el.hasAttribute && el.hasAttribute("href") ? "link" : "";
      if (t === "BUTTON") return "button";
      if (t === "TEXTAREA") return "textbox";
      if (t === "SELECT") return "combobox";
      if (t === "IMG") return "image";
      if (/^H[1-6]$/.test(t)) return "heading";
      if (t === "IFRAME" || t === "FRAME") return "Iframe";
      if (t === "INPUT") {
        const ty = typeOf(el);
        if (ty === "checkbox") return "checkbox";
        if (ty === "radio") return "radio";
        if (ty === "submit" || ty === "button" || ty === "reset" || ty === "image" || ty === "file") return "button";
        if (ty === "range") return "slider";
        if (ty === "number") return "spinbutton";
        if (ty === "search") return "searchbox";
        return "textbox";
      }
      return "";
    };
    const LANDMARK = { NAV: "navigation", MAIN: "main", HEADER: "banner", FOOTER: "contentinfo",
                       ASIDE: "complementary", FORM: "form", UL: "list", OL: "list", LI: "listitem", TABLE: "table" };
    const clampProbe = (v, dflt) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt; };
    const treeVisible = (el) => {
      const st = style(el);
      if (st && (st.display === "none" || st.visibility === "hidden" || st.visibility === "collapse")) return false;
      try { const r = el.getBoundingClientRect(); return r.width > 0 || r.height > 0; } catch (e) { return false; }
    };
    const hasOwnText = (el) => {
      for (const n of el.childNodes || []) if (n.nodeType === 3 && (n.textContent || "").trim().length >= 3) return true;
      return false;
    };
    function buildFrameTree() {
      const maxDepth = clampProbe(a.depth, 15), cap = clampProbe(a.max, 3000), visitCap = 10000;
      const entries = [], els = [];
      let visited = 0, truncated = false;
      const walk = (el, depth) => {
        if (truncated || !isEl(el)) return;
        if (++visited > visitCap) { truncated = true; return; }
        if (attr(el, "aria-hidden") === "true") return;
        const tag = el.tagName;
        // LABEL gets no entry of its own: its text already names
          // its control through describe() (the AX tree does the same),
          // and a separate label entry would duplicate the control's
          // name in find/read_page; a press on it focuses nothing.
          if (!/^(SCRIPT|STYLE|META|LINK|TITLE|NOSCRIPT|TEMPLATE|LABEL)$/.test(tag)) {
          // Cheap candidacy first: describe() is the expensive read
          // (label and form scans), so it runs only on elements that
          // could plausibly enter the tree.
          let cand = false;
          try {
            cand = el.matches(ACT) || !!el.isContentEditable ||
              /^(INPUT|TEXTAREA|SELECT|BUTTON|A|IMG|IFRAME|FRAME|SUMMARY|LABEL)$/.test(tag) ||
              /^H[1-6]$/.test(tag) || !!LANDMARK[tag] ||
              !!attr(el, "role") || !!attr(el, "aria-label") || !!attr(el, "alt") || hasOwnText(el);
          } catch (e) { cand = true; }
          if (cand) {
            const d = describe(el, "");
            const role = attr(el, "role").toLowerCase() || ROLE_BY_TAG(el) || LANDMARK[tag] ||
              (d.isContentEditable ? "textbox" : "");
            const name = (d.isField ? (d.label || d.text) : (d.text || d.label)).slice(0, 100);
            const inter = d.actionableShape || d.isField || /^(IFRAME|FRAME)$/.test(tag);
            if ((inter || !!name || !!LANDMARK[tag] || role === "heading") &&
                (treeVisible(el) || a.filter === "all" || d.isField)) {
              const r = el.getBoundingClientRect();
              const e = { i: els.length, depth, role, name,
                tag: d.tag, type: d.type, text: d.text, label: d.label, href: d.href,
                autocomplete: d.autocomplete, isField: d.isField, isPassword: d.isPassword,
                isPayField: d.isPayField, isContentEditable: d.isContentEditable,
                isSubmit: d.isSubmit, revealsSecret: d.revealsSecret, actionableShape: d.actionableShape,
                inForm: d.inForm, formHasPassword: d.formHasPassword, formHasPayment: d.formHasPayment,
                formRiskySubmit: d.formRiskySubmit, fp: d.fp,
                cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height };
              if (tag === "INPUT" && (d.type === "checkbox" || d.type === "radio")) e.checked = !!el.checked;
              if (/^(IFRAME|FRAME)$/.test(tag)) e.src = el.src || "";
              entries.push(e); els.push(el);
              if (entries.length >= cap) truncated = true;
            }
          }
        }
        if (depth >= maxDepth || truncated) return;
        for (const c of el.children || []) walk(c, depth + 1);
        if (el.shadowRoot) for (const c of el.shadowRoot.children || []) walk(c, depth + 1);
      };
      const rootEl = document.body || document.documentElement;
      if (rootEl) walk(rootEl, 0);
      // Stash the live elements for "measure": the isolated world's
      // window persists across script injections into this frame, so a
      // later call can scroll and re-measure the very same node.
      const builds = (window.__mbbTreeBuilds = window.__mbbTreeBuilds || {});
      const id = String(a.build || "b0");
      builds[id] = els;
      const keys = Object.keys(builds);
      if (keys.length > 2) delete builds[keys[0]];
      return { buildId: id, url: location.href, entries, truncated };
    }
    function measureStashed() {
      const builds = window.__mbbTreeBuilds || {};
      const els = builds[String(a.build || "")];
      const el = els && els[Number(a.i)];
      if (!el || !el.isConnected) return null;
      try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (e) {}
      const r = el.getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height,
               checked: typeof el.checked === "boolean" ? el.checked : undefined, d: describe(el, "") };
    }
    function frameRects() {
      const out = [];
      let list = [];
      try { list = [...document.querySelectorAll("iframe,frame")]; } catch (e) {}
      for (const el of list) {
        const r = el.getBoundingClientRect();
        out.push({ src: el.src || "", left: r.left, top: r.top,
                   clientLeft: el.clientLeft || 0, clientTop: el.clientTop || 0, w: r.width, h: r.height });
      }
      return out;
    }
    function run() {
      if (mode === "point" || mode === "refpoint") {
        const h = hitAt(a.x, a.y);
        if (h.offscreen) return { offscreen: true, fp: "offscreen" };
        if (!h.el) return null;
        const d = h.crossOrigin ? { crossOriginFrame: true, frameHost: h.frameHost, tag: "iframe", fp: "iframe|" + h.frameHost }
                                : describe(actionable(h.el), h.frameHost);
        if (mode === "refpoint") {
          let ref = isEl(this) ? this : this && this.parentElement;
          if (ref && ref.tagName === "LABEL" && ref.control) ref = ref.control;
          d.covered = !ref || !(related(ref, h.el) || related(h.el, ref) || related(actionable(ref), h.el));
        }
        return d;
      }
      if (mode === "node") {
        const el = isEl(this) ? this : this && this.parentElement;
        return el ? describe(el, "") : null;
      }
      if (mode === "focus") {
        let doc = document, el = doc.activeElement, fh = "";
        for (let i = 0; el && i < 20; i++) {
          if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; }
          if (/^(IFRAME|FRAME)$/.test(el.tagName)) {
            const fi = frameInfo(el);
            if (fi.crossOrigin) return { kind: "crossOriginFrame", frameHost: fi.host, fp: "iframe|" + fi.host };
            doc = fi.doc; fh = hostOf(doc.location.href); el = doc.activeElement; continue;
          }
          break;
        }
        if (!el || el === doc.body || el === doc.documentElement) return { kind: "none", fp: "none" };
        // Resolve focus the way "point" does: climb to the actionable
        // element (a semantic control, or the outermost pointer-cursor
        // ancestor for a styled clickable div) and describe that, so a
        // custom div-button is judged by the same words a click on it
        // would be. Without the climb its text was never classified.
        const act = actionable(el);
        const d = describe(act, fh);
        // Field facts belong to the focused element itself: if focus is
        // in a genuine field inside the climbed element, keep it a field
        // (describe() already suppresses a field's own text).
        const foc = act === el ? d : describe(el, fh);
        if (foc.isField) { d.isField = true; d.isPassword = foc.isPassword; d.text = ""; }
        // A custom element with no open shadow root may hold focus in a closed
        // one: the worker asks Chrome's accessibility tree instead.
        d.kind = el.tagName.includes("-") && !el.shadowRoot && !el.isContentEditable && !el.matches(ACT) ? "opaque" : "element";
        // describe() sets isField only for input/textarea/select or
        // contenteditable, so a non-editable div with role="textbox"
        // stays actionable here and is classified by its words.
        d.actionable = !d.isField;
        if (d.isField) d.len = el.isContentEditable ? (el.textContent || "").length : String(el.value == null ? "" : el.value).length;
        return d;
      }
      if (mode === "fields") {
        // No slice cap (see the mode list above) and the scan is deep
        // (shadow roots + same-origin frames), so a sensitive field cannot
        // hide behind padding fields or inside a component/frame.
        // Payment fields, hidden inputs and one-time-code fields are
        // masked the same as passwords: presence and type only, never
        // the value. (isPwd already covers one-time-code for inputs;
        // the explicit check keeps that true for every field kind and
        // for hidden inputs, whose isPwd check returns early.)
        return deepScan().fields.map((e) => {
          const hidden = isPwd(e) || isPay(e) || typeOf(e) === "hidden" ||
            /one-time-code/i.test(attr(e, "autocomplete")) || /(^|\s)cc-/i.test(attr(e, "autocomplete"));
          return {
            name: e.name || e.id || "", type: (attr(e, "type") || e.tagName).toLowerCase(),
            value: hidden ? "(hidden)" : (e.type === "checkbox" || e.type === "radio") ? e.checked : String(e.value || "").slice(0, 500),
            autocomplete: attr(e, "autocomplete") || "",
            isPassword: isPwd(e), isPayField: isPay(e),
          };
        });
      }
      if (mode === "shotcheck") {
        const scan = deepScan();
        return { password: scan.fields.some(isPwd), payment: scan.fields.some(isPay),
                 crossOriginFrame: scan.crossOriginFrame, fieldCount: scan.fields.length };
      }
      if (mode === "text") {
        const el = document.querySelector("main, article, [role=main]") || document.body;
        return (el ? el.innerText : "").slice(0, 100000);
      }
      if (mode === "tree") return buildFrameTree();
      if (mode === "measure") return measureStashed();
      if (mode === "frames") return frameRects();
      return null;
    }
    return { host: location.host.toLowerCase(), v: run.call(this) };
  }

  const api = { hostOf, isWebUrl, classifyTarget, classifyClick, classifyActivation, classifyTyping,
                classifyFormInput, classifyFormFill, isSecretField,
                describeTarget, shownTyping, parseKeys, isActivationKey, isTypingKey, keyName, parseRef,
                INTERACTIVE_ROLES, ACTION_ROLES, rankForQuery, clip, RISK_RE, pageProbe, luhnValid, redactText, normalizeLabel,
                PROBE_ARGS: { risk: [RISK_RE.source, RISK_RE.flags] } };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MBB = api;
})(typeof self !== "undefined" ? self : this);

