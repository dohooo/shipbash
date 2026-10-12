// What the verification leg concludes from one settled frame, and nothing
// else. The page's kind and whether it holds a human check are Jev's
// judgment (page-kind.mjs); the order below is the order the person needs.
// A frame nobody could read, or Jev did not judge, proves nothing and gets
// the word for "we do not know". A challenge that a person is driving the
// browser is named as one, and so is a second factor, because each is the
// reason they cannot hand this account over unattended — never "your session
// expired". Otherwise the session has to end up on the product, on a page
// that does not need the owner.
import { hostOf, registrableDomain } from "@shipbash/contracts/runtime/sign-in-scope.mjs";

import { judgmentSignal, needsOwner, showsHumanCheck } from "../page-kind.mjs";

// Every failure word here is in team_sign_ins.failure_reason; a leg never
// invents one, because the card's sentence is chosen by it.

// One accessibility-snapshot row as agent-browser prints it:
//   `  - role "name" [attrs]`               the common shape
//   `  - textbox "Email" [attrs]: value`    a filled field, value after attrs
//   `  - generic "Skip" [attrs] clickable [cursor:pointer, onclick]`
//   `  - text: ada@northwind.example`       a text node
const SNAPSHOT_LINE_PATTERN =
  /^(\s*)-\s+([A-Za-z][\w-]*)(?:\s+"((?:[^"\\]|\\.)*)")?(?:\s+\[([^\]]*)\])?(?:\s+(clickable|focusable|editable)\s+\[([^\]]*)\])?(?:\s*:\s*(.*))?\s*$/u;
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/u;
const ACCOUNT_CONTROL_PATTERN =
  /\b(account|profile|avatar|user menu|my account|signed in as|logged in as)\b/iu;
const GENERIC_LABEL_PATTERN =
  /^(account|profile|avatar|user|menu|settings|my account|user menu|open user menu)$/iu;
const USERNAME_PATTERN = /^[\w][\w.@+-]{1,63}$/u;
const DISPLAY_NAME_PATTERN = /^[\w][\w.@+' -]{1,63}$/u;
const LABEL_LOOKAHEAD = 3;

/** The snapshot's rows as {role, name, attrs, value}; rows the pattern does not recognise are skipped. */
function snapshotRows(snapshotText) {
  const rows = [];
  for (const line of String(snapshotText ?? "").split("\n")) {
    const match = SNAPSHOT_LINE_PATTERN.exec(line);
    if (!match) continue;
    const role = match[2].toLowerCase();
    rows.push({
      role,
      name: (match[3] ?? (role === "text" ? match[7] : "") ?? "").trim(),
      attrs: `${match[4] ?? ""} ${match[6] ?? ""}`.trim().toLowerCase(),
      value: (match[7] ?? "").trim(),
    });
  }
  return rows;
}

/**
 * The account this session belongs to, as the product itself states it: an
 * email anywhere on the page first, otherwise a handle sitting on or just
 * under an account control. Null when the page names nobody — a label the
 * leg could not read is never guessed, because the card shows it as fact.
 *
 * @param {string} snapshotText The frame's interactive snapshot.
 * @returns {string | null}
 */
export function accountLabelFrom(snapshotText) {
  const rows = snapshotRows(snapshotText);
  for (const row of rows) {
    const email = EMAIL_PATTERN.exec(`${row.name} ${row.value}`);
    if (email) return email[0];
  }
  for (const [index, row] of rows.entries()) {
    if (!ACCOUNT_CONTROL_PATTERN.test(`${row.name} ${row.attrs}`)) continue;
    // The control's own name may be the person's display name ("Ada
    // Lovelace"); the rows under it are only trusted for a handle with no
    // spaces, because anything looser there picks up the page's own words.
    const own = row.name.trim();
    if (own && !GENERIC_LABEL_PATTERN.test(own) && DISPLAY_NAME_PATTERN.test(own)) return own;
    for (const candidate of rows.slice(index + 1, index + 1 + LABEL_LOOKAHEAD)) {
      const text = (candidate.name || candidate.value).trim();
      if (!text || GENERIC_LABEL_PATTERN.test(text) || !USERNAME_PATTERN.test(text)) continue;
      return text;
    }
  }
  return null;
}

/**
 * The leg's verdict for one frame.
 *
 * @param {{ url: string, title: string, snapshotText: string } | null} frame The settled frame, or null when the browser answered nothing.
 * @param {string} productionUrl The product the leg opened.
 * @param {(frame: { url: string, title: string, snapshotText: string }, options: { humanCheck: boolean }) => Promise<import("../page-kind.mjs").PageJudgment>} judge
 * @returns {Promise<{
 *   verified: boolean,
 *   reason: "second_factor_required" | "captcha_required" | "session_expired" | "unknown" | null,
 *   label: string | null,
 *   kind: string,
 *   judged: string,
 *   humanCheck?: number | null,
 * }>}
 */
export async function signInVerdict(frame, productionUrl, judge) {
  // A harness fault that read as a product verdict is what made every check
  // fail once; "unread" on the kind is the tell.
  if (!frame || (!frame.url && !frame.snapshotText)) {
    return { verified: false, reason: "unknown", label: null, kind: "unread", judged: "" };
  }
  const judgment = await judge(frame, { humanCheck: true });
  const report = { kind: judgment.kind ?? "unjudged", judged: judgmentSignal(judgment), humanCheck: judgment.humanCheck };
  if (judgment.kind === null) return { verified: false, reason: "unknown", label: null, ...report };
  // A challenge is named whatever kind the page is otherwise taken for: a
  // puzzle can read as a code step, and it is still no code the owner has.
  if (showsHumanCheck(judgment)) return { verified: false, reason: "captcha_required", label: null, ...report };
  if (judgment.kind === "second_factor") return { verified: false, reason: "second_factor_required", label: null, ...report };
  const productSite = registrableDomain(hostOf(productionUrl));
  const frameSite = registrableDomain(hostOf(frame.url));
  // Neither side of the comparison can be read, so nothing here proves the
  // leg got inside. It says so in the one word that means exactly that.
  if (productSite.length === 0 || frameSite.length === 0) return { verified: false, reason: "unknown", label: null, ...report };
  if (frameSite === productSite && !needsOwner(judgment)) {
    return { verified: true, reason: null, label: accountLabelFrom(frame.snapshotText), ...report };
  }
  // Off the product, or on a page only the owner can get past: the session
  // did not carry, which reads to the person as one to sign in again.
  return { verified: false, reason: "session_expired", label: null, ...report };
}
