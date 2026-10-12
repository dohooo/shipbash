"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { webClient } from "../../lib/web-client";
import { readKey } from "../../lib/queries";
import {
  HOOK_ROLES,
  caseSlotLabel,
  perJourneySlot,
  readCaseRole,
} from "../_lib/case-slot";
import type { ProjectJourney } from "../_lib/journeys";
import { mutationMessage } from "../_lib/request-errors";
import { EditDialog } from "./edit-dialog";
import {
  JourneyDraftFields,
  journeyDraftCaseInput,
  useJourneyDraft,
  type JourneyDraft,
  type JourneyDraftSource,
} from "./journey-script-editor";
import { useProduct } from "./shell";

/** A blank hook: one step and the two shoulds the script guard asks for. */
const NEW_HOOK: JourneyDraftSource = {
  title: "",
  category: "Setup",
  whyItMatters: null,
  steps: [{ id: "step-1", instruction: "" }],
  checkpoints: [
    { id: "cp-1", goal: "", afterStep: "step-1" },
    { id: "cp-2", goal: "", afterStep: "step-1" },
  ],
  role: "before_all",
  scopeCaseId: null,
};

/** The slot, and for a per-journey slot the Journey it is around. */
function HookSlotFields({ draft, journeys }: {
  draft: JourneyDraft;
  journeys: ReadonlyArray<Pick<ProjectJourney, "id" | "title">>;
}) {
  return (
    <>
      <label className="form-field form-field-compact">
        <span>When</span>
        <select value={draft.role} onChange={(event) => draft.setRole(readCaseRole(event.target.value))}>
          {HOOK_ROLES.map((role) => <option key={role} value={role}>{caseSlotLabel(role)}</option>)}
        </select>
      </label>
      {perJourneySlot(draft.role) ? (
        <label className="form-field form-field-compact">
          <span>Journey</span>
          <select value={draft.scopeCaseId ?? ""} onChange={(event) => draft.setScopeCaseId(event.target.value || null)}>
            <option value="">Every journey</option>
            {journeys.map((journey) => <option key={journey.id} value={journey.id}>{journey.title}</option>)}
          </select>
        </label>
      ) : null}
    </>
  );
}

/**
 * Add or edit a setup/teardown hook. A hook publishes on save: it is
 * not a product verdict, so no Edit run has to prove it first, and a slot
 * change could not ride a staged draft anyway.
 */
export function HookEditModal({ hook, suiteId, suiteRevision, journeys, onClose }: {
  /** The hook to edit; null adds one to the Suite. */
  hook: ProjectJourney | null;
  suiteId: string;
  /** The Suite's `definitionRevision` as rendered. */
  suiteRevision: number;
  /** The project's Journeys; the Suite's own are the scopes a per-journey slot offers. */
  journeys: ReadonlyArray<Pick<ProjectJourney, "id" | "title" | "suiteId">>;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { project } = useProduct();
  const draft = useJourneyDraft(hook ?? NEW_HOOK);
  const save = useMutation({
    mutationFn: () => {
      // The server derives a hook's category from its slot.
      const { category: _category, ...script } = journeyDraftCaseInput(draft, hook?.enabled ?? true);
      const input = { ...script, expectedRevision: suiteRevision };
      return hook
        ? webClient.updateCase(project.id, suiteId, hook.id, input)
        : webClient.addCase(project.id, suiteId, input);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: readKey("journeys", project.id) });
      toast.success(hook ? "Hook saved" : "Hook added");
      onClose();
    },
  });
  const incomplete = !draft.title.trim() || draft.shouldCountInvalid || draft.hasBlankRow;
  return (
    <EditDialog
      heading={hook ? "Edit hook" : "New hook"}
      subject={hook?.title ?? null}
      error={save.isError ? mutationMessage(save.error) : null}
      saveLabel={hook ? "Save" : "Add hook"}
      saveDisabled={save.isPending || incomplete}
      onSave={() => save.mutate()}
      onClose={onClose}
    >
      <div className="edit-fields">
        <HookSlotFields draft={draft} journeys={journeys.filter((journey) => journey.suiteId === suiteId)} />
        <JourneyDraftFields categoryOptions={null} draft={draft} />
      </div>
    </EditDialog>
  );
}
