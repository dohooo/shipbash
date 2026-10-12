import { isRecord as record } from "@shipbash/contracts/runtime/contract-values.mjs";
import { ITEM_ID_PATTERN } from "@shipbash/contracts/runtime/checklist-contract.mjs";
import { MAX_RECORDING_CAPTION_LENGTH, MAX_RECORDING_CHAPTER_LENGTH } from "@shipbash/contracts/runtime/recording-bounds.mjs";

import { createJsonlRevisionReader, parseRevisionEnvelope } from "./jsonl-progress-reader.mjs";

function text(value, field, maximumLength) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  const normalized = value.trim();
  if (normalized.length > maximumLength || /[\r\n]/u.test(normalized)) {
    throw new Error(`${field} must be one line with at most ${String(maximumLength)} characters.`);
  }
  return normalized;
}

export function validateNarrationInput(value) {
  if (!record(value)) throw new Error("Narration must be an object.");
  const caption = text(value.caption, "caption", MAX_RECORDING_CAPTION_LENGTH);
  if (!/\bI\b/u.test(caption)) {
    throw new Error("caption must speak in concise first person using ‘I’.");
  }
  const chapterId = text(value.chapterId, "chapterId", MAX_RECORDING_CHAPTER_LENGTH);
  if (!ITEM_ID_PATTERN.test(chapterId)) {
    throw new Error("chapterId contains unsafe characters.");
  }
  return {
    caption,
    chapterId,
    chapterTitle: text(value.chapterTitle, "chapterTitle", MAX_RECORDING_CHAPTER_LENGTH),
  };
}

function parseNarrationEvent(line, expectedRevision = 1) {
  const value = parseRevisionEnvelope(line, expectedRevision, "Narration channel");
  if (value.event !== "agent_narration") {
    throw new Error("Narration channel emitted an invalid or out-of-order event.");
  }
  return validateNarrationInput(value);
}

export async function startNarrationReader(eventPath, onNarration) {
  return createJsonlRevisionReader(eventPath, {
    channelName: "Narration channel",
    onLine: (line, revision) => {
      onNarration(parseNarrationEvent(line, revision));
    },
  });
}
