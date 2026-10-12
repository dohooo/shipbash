"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import type { SuiteDetail } from "../../lib/web-client";
import { caseSlotLabel } from "../_lib/case-slot";
import { hookAuthor, hookScopeLabel, hooksBySlot } from "../_lib/journey-hooks";
import { caseResultDots, type ProjectJourney } from "../_lib/journeys";
import { HookEditModal } from "./hook-edit-modal";
import { journeyMark } from "./journeys-page-model";
import { JourneyRowMenu, useJourneyRowLink } from "./journeys-page-table";
import { RelativeTime } from "./relative-time";
import { Exception, ResultDots } from "./shell";

/** One hook: its name and scope, who wrote it, how its runs went. */
function HookTableRow({ hook, journeys, onEdit }: {
  hook: ProjectJourney;
  journeys: readonly ProjectJourney[];
  onEdit: () => void;
}) {
  const { href, onRowClick } = useJourneyRowLink(hook.id);
  const scope = hookScopeLabel(hook, journeys);
  return (
    <tr className="journey-row" onClick={onRowClick}>
      <td>
        <span className="journey-hook-name">
          <Link className="row-link" href={href} onClick={(event) => event.stopPropagation()}>
            {hook.title}
          </Link>
          <Exception mark={journeyMark(hook)} />
          {scope ? <span className="journey-hook-scope">{scope}</span> : null}
        </span>
      </td>
      <td>{hookAuthor(hook.origin)}</td>
      <td className="results-col">
        <ResultDots label={`Recent results for ${hook.title}`} results={caseResultDots(hook)} />
      </td>
      <td>
        {hook.latestRunAt
          ? <RelativeTime value={hook.latestRunAt} />
          : <span className="journey-never">Not run yet</span>}
      </td>
      <td>
        <JourneyRowMenu journey={hook} onEdit={onEdit} />
      </td>
    </tr>
  );
}

/**
 * Setup and teardown around the journeys, one group per slot in run order.
 * Nothing here is a product verdict; a failed teardown says so on its row.
 */
function JourneysHooksBlock({ hooks, journeys, onEdit, onAdd }: {
  hooks: readonly ProjectJourney[];
  journeys: readonly ProjectJourney[];
  onEdit: (hook: ProjectJourney) => void;
  /** Null when no active Suite can take a hook. */
  onAdd: (() => void) | null;
}) {
  return (
    <section className="section" id="before-after" aria-labelledby="before-after-title">
      <header className="section-head">
        <h2 id="before-after-title">Before &amp; after</h2>
        {hooks.length ? (
          <span className="section-head-side">
            {hooks.length === 1 ? "1 hook" : `${String(hooks.length)} hooks`}
            {onAdd ? (
              <button className="button" type="button" onClick={onAdd}>
                <Plus aria-hidden="true" /> Add hook
              </button>
            ) : null}
          </span>
        ) : null}
      </header>
      {hooks.length ? (
        <div className="grid-frame">
          <table className="table data-table journey-table journey-hook-table" aria-label="Setup and teardown hooks">
            <thead><tr><th>Hook</th><th>Added by</th><th className="results-col">Recent runs</th><th>Last run</th><th /></tr></thead>
            {hooksBySlot(hooks).map((group) => (
              <tbody key={group.role}>
                <tr className="journey-group-row"><th colSpan={5} scope="rowgroup">{caseSlotLabel(group.role)}</th></tr>
                {group.hooks.map((hook) => (
                  <HookTableRow key={hook.id} hook={hook} journeys={journeys} onEdit={() => onEdit(hook)} />
                ))}
              </tbody>
            ))}
          </table>
        </div>
      ) : onAdd ? (
        <button className="quiet-link" type="button" onClick={onAdd}>Add a setup or teardown hook</button>
      ) : null}
    </section>
  );
}

/**
 * The block plus the editor it opens: an existing hook, or "new" for one
 * added to the Suite that takes it. Off the page until a Journey exists.
 */
export function JourneysHooks({ hooks, journeys, suite }: {
  hooks: readonly ProjectJourney[];
  journeys: readonly ProjectJourney[];
  /** The active Suite a new hook joins, as rendered; null when none can take one. */
  suite: Pick<SuiteDetail, "id" | "definitionRevision"> | null;
}) {
  /** The id of the hook being edited, or "new". */
  const [editing, setEditing] = useState<string | null>(null);
  if (!journeys.length) return null;
  // Read from the live list: after a refetch the editor saves against the
  // revision it brought, and a hook that is gone closes its editor.
  const hook = editing === "new" ? null : hooks.find((entry) => entry.id === editing) ?? null;
  const target = editing === "new"
    ? suite && { suiteId: suite.id, suiteRevision: suite.definitionRevision }
    : hook;
  return (
    <>
      <JourneysHooksBlock
        hooks={hooks}
        journeys={journeys}
        onEdit={(entry) => setEditing(entry.id)}
        onAdd={suite ? () => setEditing("new") : null}
      />
      {editing && target ? (
        <HookEditModal
          key={editing}
          hook={hook}
          suiteId={target.suiteId}
          suiteRevision={target.suiteRevision}
          journeys={journeys}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}
