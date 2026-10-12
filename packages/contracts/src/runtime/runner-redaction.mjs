/**
 * The redaction machinery the two container runners AND the two host
 * runtimes share. One implementation, four deliberate configurations — the
 * differences are contract, not drift: the suite runner passes valid auth
 * states through under authState keys and never caps collections; the
 * Activity runner redacts a bare `token` key-value, caps collections at 50
 * entries, and clamps safeError at 500 instead of 1000; the host Activity
 * runtime uses the `$1=[REDACTED]` equals separator for key-values; the
 * host Docker runtime has no key-value rule at all and truncates with an
 * ellipsis BEFORE redacting instead of slicing after. Each caller passes
 * its own patterns and limits; the factory owns the sensitive-runtime-value
 * set and the encoded forms a registered secret is masked in, and hosts thread per-call sensitive values through the extra
 * parameter (empty entries are skipped, matching the host guard).
 */
import { isRecord } from "./contract-values.mjs";

/**
 * The chunk sink that feeds one redacted line at a time to `write`. A chunk
 * ends mid-line often, so the trailing partial is held until the rest arrives.
 */
function redactedLineSink(write, redactLine) {
  let buffer = "";
  const writeLine = (line) => write(`${redactLine(line)}\n`);
  return {
    push(chunk) {
      buffer += String(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        writeLine(line);
      }
    },
    finish() {
      if (buffer.length > 0) {
        writeLine(buffer);
        buffer = "";
      }
    },
  };
}

/**
 * A registered secret shorter than this is not masked: a short value turns up
 * in ordinary output and inside escape sequences (`0m` in `\e[0m`), and
 * masking it there breaks what the text around it says. A one-time code is
 * the one short secret masked all the same: it is six digits, and no escape
 * sequence a terminal program writes carries six digits in a row.
 */
const MIN_SECRET_LENGTH = 8;
const ONE_TIME_CODE = /^\d{6,}$/u;
/** Shorter base64 fragments than this are too common in ordinary output to mask. */
const MIN_BASE64_FORM_LENGTH = 8;

/**
 * The base64 text a value becomes inside a longer encoded run, such as
 * `Basic base64(user:password)`. Where the value starts relative to the 3-byte
 * groups decides its characters, so each of the three alignments is kept, and
 * only the groups made of the value's own bytes: the last partial group's
 * characters depend on whatever follows it. GitHub Actions' SecretMasker
 * registers the same three shifts (ValueEncoders.Base64StringEscapeShift1/2).
 */
function base64Forms(value) {
  const bytes = Buffer.from(value, "utf8");
  return [0, 1, 2].flatMap((shift) => {
    const aligned = bytes.subarray(shift);
    const form = aligned.subarray(0, aligned.length - (aligned.length % 3)).toString("base64");
    return form.length >= MIN_BASE64_FORM_LENGTH ? [form] : [];
  });
}

/** A secret as output can carry it: as is, JSON-escaped, URL-encoded and base64-encoded. */
function secretForms(value) {
  return [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), ...base64Forms(value)];
}

function maskable(value) {
  return typeof value === "string" && (value.length >= MIN_SECRET_LENGTH || ONE_TIME_CODE.test(value));
}

/** Registers what a served sign-in carries; answers the names of the values too short to mask. */
function registerCredentialValues(registerSecret, value) {
  return [["password", value?.password], ["one-time code", value?.totp?.code]]
    .filter(([, secret]) => typeof secret === "string" && secret !== "" && !registerSecret(secret))
    .map(([name]) => name);
}

/**
 * Every value replaced, longest first: a value that contains another goes
 * whole, not in pieces around the shorter one's marker. Empty entries are
 * skipped, as the hosts' per-call values may carry them.
 */
function replaceSensitiveValues(text, values) {
  let redacted = text;
  for (const value of values.filter(Boolean).sort((left, right) => right.length - left.length)) {
    redacted = redacted.replaceAll(value, "[REDACTED]");
  }
  return redacted;
}

/**
 * The shapes a secret has wherever it appears, each with what replaces a
 * match. A JWT needs no keyword beside it to be one: its header and payload
 * are base64url JSON, so both open with `eyJ`. A query parameter is a secret
 * when its name says so anywhere in it — `reset_password_token`, `oobCode`,
 * `X-Amz-Signature` — and so is an OAuth `state`.
 */
const SECRET_PATTERNS = [
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/gu, "[REDACTED]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED]"],
  [/(https?:\/\/)[^/@\s]+:[^/@\s]+@/giu, "$1[REDACTED]@"],
  [/([?&](?:[\w.-]*(?:token|code|key|secret|password|signature|auth)[\w.-]*|state)=)[^&#\s]*/giu, "$1[REDACTED]"],
  [/\b(authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]+/giu, "$1: [REDACTED]"],
];

/** A replacement with its `$n` references read from the match. */
function expandReplacement(replacement, match) {
  return replacement.replace(/\$(\d)/gu, (_reference, group) => match[Number(group)] ?? "");
}

/**
 * Where `text` holds one of `values` or matches one of `patterns`, each with
 * what replaces it — the same matches redactString replaces, found on the
 * text as it is, so a caller can place each replacement itself.
 */
function sensitiveRangesIn(text, values, patterns) {
  const ranges = [];
  for (const value of values) {
    for (let start = text.indexOf(value); start !== -1; start = text.indexOf(value, start + value.length)) {
      ranges.push({ start, end: start + value.length, replacement: "[REDACTED]" });
    }
  }
  for (const [pattern, replacement] of patterns) {
    for (const match of text.matchAll(pattern)) {
      ranges.push({ start: match.index, end: match.index + match[0].length, replacement: expandReplacement(replacement, match) });
    }
  }
  return ranges;
}

export function createRedactor({
  sensitiveKeyPattern,
  keyValuePattern = null,
  keyValueReplacement = "$1: [REDACTED]",
  authStates = null,
  collectionEntryCap = null,
  truncation = "redact-then-slice",
  safeErrorLimit,
} = {}) {
  const sensitiveRuntimeValues = new Set();
  const patterns = keyValuePattern ? [...SECRET_PATTERNS, [keyValuePattern, keyValueReplacement]] : SECRET_PATTERNS;

  function registerSecret(value) {
    if (!maskable(value)) return false;
    for (const form of secretForms(value)) sensitiveRuntimeValues.add(form);
    return true;
  }

  function applySensitiveValues(value, extraSensitiveValues) {
    return replaceSensitiveValues(value, [...sensitiveRuntimeValues, ...(extraSensitiveValues ?? [])]);
  }

  function redactString(value, maximumLength = 4_000, extraSensitiveValues = null) {
    let redacted = applySensitiveValues(String(value), extraSensitiveValues);
    if (truncation === "ellipsis-before-redact" && redacted.length > maximumLength) {
      redacted = `${redacted.slice(0, maximumLength)}…`;
    }
    for (const [pattern, replacement] of patterns) redacted = redacted.replace(pattern, replacement);
    return truncation === "ellipsis-before-redact" ? redacted : redacted.slice(0, maximumLength);
  }

  function redactValue(value, key = "", extraSensitiveValues = null) {
    if (authStates && key && /auth[-_]?state/iu.test(key) && authStates.has(value)) {
      return value;
    }
    if (key && sensitiveKeyPattern.test(key)) {
      return "[REDACTED]";
    }
    if (typeof value === "string") {
      return redactString(value, undefined, extraSensitiveValues);
    }
    if (Array.isArray(value)) {
      const entries = collectionEntryCap === null ? value : value.slice(0, collectionEntryCap);
      return entries.map((entry) => redactValue(entry, "", extraSensitiveValues));
    }
    if (isRecord(value)) {
      const entries = collectionEntryCap === null
        ? Object.entries(value)
        : Object.entries(value).slice(0, collectionEntryCap);
      return Object.fromEntries(entries.map(([entryKey, entryValue]) => [
        entryKey,
        redactValue(entryValue, entryKey, extraSensitiveValues),
      ]));
    }
    return value;
  }

  function redactSensitiveRuntimeValues(value, extraSensitiveValues = null) {
    if (typeof value === "string") {
      return applySensitiveValues(value, extraSensitiveValues);
    }
    if (Array.isArray(value)) {
      return value.map((entry) => redactSensitiveRuntimeValues(entry, extraSensitiveValues));
    }
    if (isRecord(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
        key,
        redactSensitiveRuntimeValues(entry, extraSensitiveValues),
      ]));
    }
    return value;
  }

  function safeError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return redactString(message).slice(0, safeErrorLimit);
  }

  function redactLogLine(line) {
    const normalized = String(line);
    try {
      return JSON.stringify(redactValue(JSON.parse(normalized)));
    } catch {
      return String(redactValue(normalized));
    }
  }

  return {
    sensitiveRuntimeValues,
    registerSecret,
    registerCredentialValues: (value) => registerCredentialValues(registerSecret, value),
    registerTrustedAccess: (trustedAccess) => registerSecret(trustedAccess?.headerValue),
    redactString,
    sensitiveRanges: (text) => sensitiveRangesIn(text, sensitiveRuntimeValues, patterns),
    /** Terminal output, masked whole: no length cap, since a shell's output is not a field. */
    redactTerminalText: (text) => redactString(text, Number.POSITIVE_INFINITY),
    redactValue,
    redactSensitiveRuntimeValues,
    safeError,
    redactLogLine,
    createRedactedLineSink: (write) => redactedLineSink(write, redactLogLine),
  };
}
