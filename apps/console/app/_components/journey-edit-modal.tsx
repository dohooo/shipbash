"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { type Proposal, webClient } from "../../lib/web-client";
import { readKey } from "../../lib/queries";
import type { ProjectJourney, StagedCaseEdit } from "../_lib/journeys";
import { mutationMessage } from "../_lib/request-errors";
import { EditDialog } from "./edit-dialog";
import { JourneyDraftFields, journeyDraftCaseInput, useJourneyDraft } from "./journey-script-editor";
import { useProduct } from "./shell";

/**
 * Edit-journey modal: say the change in words, optionally adjust the fields,
 * and stage both as a draft — nothing publishes until an Edit run proves it.
 * Once a walk verifies the staged edits they hold still, so the modal says so
 * and saves nothing until they are kept or discarded. A Journey's role is
 * fixed here; a hook is edited in HookEditModal.
 */
export function JourneyEditModal({
  journey,
  staged,
  walk,
  categoryOptions,
  onClose,
}: {
  journey: ProjectJourney;
  staged: StagedCaseEdit | undefined;
  /** The latest walk of the Suite's staged edits, or null before one started. */
  walk: Proposal["walk"];
  categoryOptions: readonly string[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { project, teamHref } = useProduct();
  // Re-opening a staged edit resumes from the staged candidate, not live.
  const stagedCase = staged?.proposal.candidateDefinition
    .find((candidate) => candidate.id === journey.id) ?? null;
  const draft = useJourneyDraft(stagedCase ?? journey);
  const [instruction, setInstruction] = useState(staged?.instruction ?? "");
  const save = useMutation({
    mutationFn: () => webClient.stageJourneyEdit(project.id, journey.suiteId, journey.id, {
      instruction: instruction.trim(),
      case: journeyDraftCaseInput(draft, journey.enabled),
      expectedRevision: journey.suiteRevision,
    }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: readKey("journeys", project.id) });
      onClose();
    },
  });
  return (
    <EditDialog
      heading="Edit journey"
      subject={journey.title}
      notice={walk ? (
        <p className="form-note" role="status">
          Verify or discard the staged edits first.{" "}
          <Link href={teamHref(`/activities/${encodeURIComponent(walk.activityId)}`)}>Review walk</Link>
        </p>
      ) : null}
      error={save.isError ? mutationMessage(save.error) : null}
      saveLabel="Save"
      saveDisabled={walk !== null || save.isPending || draft.shouldCountInvalid || draft.hasBlankRow}
      onSave={() => save.mutate()}
      onClose={onClose}
    >
      <div className="edit-say">
        <textarea
          // biome-ignore lint/a11y/noAutofocus: the reader opened this dialog from the row menu to say a change; the textarea is what it opened for.
          autoFocus
          placeholder="e.g. after placing the order, also check the receipt email arrives — and use the Amex on file instead of the 4242 card"
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
        />
      </div>
      <details className="edit-more">
        <summary>
          <ChevronRight aria-hidden="true" className="edit-caret" />
          Edit manually
          <em>title · category · why · script</em>
        </summary>
        <div className="edit-fields">
          <JourneyDraftFields categoryOptions={categoryOptions} draft={draft} />
        </div>
      </details>
    </EditDialog>
  );
}
