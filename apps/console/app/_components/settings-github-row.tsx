"use client";

/**
 * One row of a GitHub connection's table, in the only two shapes it has: a
 * project that reads a repository, or the one being bound. It is the Slack
 * routing row with a repository where the channel was and a read where the
 * test was — the same classes, the same disabled states.
 */
import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

import type { GitHubBinding, GitHubRepository, Project } from "../../lib/web-client";
import { RelativeTime } from "./relative-time";
import { projectMark } from "./workspace-marks";

/** The select's empty value: "No repository" on a bound row, "Pick a repository" on a new one. */
export const NO_REPOSITORY = "";

/** The repositories a row may choose from: everything listed, plus the one it already reads. */
function repositoryOptions(
  listed: readonly GitHubRepository[],
  current: GitHubRepository | null,
): GitHubRepository[] {
  if (!current || listed.some((repository) => repository.id === current.id)) return [...listed];
  return [current, ...listed];
}

/** A day, without the year: a revoked row's last read is days old, not hours. */
function shortDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export interface GitHubRowProps {
  /** The binding this row draws, or null while the row is the one being bound. */
  binding: GitHubBinding | null;
  /** Only a row with no binding offers these; a bound row's project is fixed. */
  choices: readonly Project[];
  repositories: readonly GitHubRepository[];
  projectId: string;
  repositoryId: string;
  /** Why the last repository chosen in this row was not saved, said under the row. */
  failure: string | null;
  admin: boolean;
  /** Every row goes inert together, and the read times freeze where they are. */
  revoked: boolean;
  busy: boolean;
  reading: boolean;
  onProject: (projectId: string) => void;
  onRepository: (repositoryId: string) => void;
  /** This row's repository select was opened; the repository list is read then and not before. */
  onOpen: () => void;
  onRead: () => void;
}

function ProjectCell({ binding, choices, projectId, disabled, onProject }: Pick<
  GitHubRowProps,
  "binding" | "choices" | "projectId" | "onProject"
> & { disabled: boolean }) {
  if (binding) {
    return (
      <span className="slack-routing-product">
        <span className="rail-mark" aria-hidden="true">
          {projectMark({ name: binding.projectName, productionUrl: null })}
        </span>
        <b>{binding.projectName}</b>
      </span>
    );
  }
  return (
    <label className="form-field">
      <select aria-label="Project" disabled={disabled} onChange={(event) => onProject(event.target.value)} value={projectId}>
        <option value="">Pick a project…</option>
        {choices.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </select>
    </label>
  );
}

function RepositoryCell({ binding, options, repositoryId, disabled, onRepository, onOpen }: Pick<
  GitHubRowProps,
  "binding" | "repositoryId" | "onRepository" | "onOpen"
> & { options: readonly GitHubRepository[]; disabled: boolean }) {
  return (
    <label className="form-field">
      <select
        aria-label={binding ? `Repository for ${binding.projectName}` : "Repository"}
        disabled={disabled}
        onChange={(event) => onRepository(event.target.value)}
        onFocus={onOpen}
        value={repositoryId}
      >
        {binding ? null : <option value={NO_REPOSITORY}>Pick a repository…</option>}
        {options.map((repository) => (
          <option key={repository.id} value={String(repository.id)}>{repository.name}</option>
        ))}
        {/* How a row stops reading: the last option of this select, as the design draws it. */}
        {binding ? <option value={NO_REPOSITORY}>No repository</option> : null}
      </select>
    </label>
  );
}

function readTip(revoked: boolean, binding: GitHubBinding): string {
  if (revoked) return "Reconnect GitHub to read";
  if (!binding.readable) return "Not visible to this account — add it on GitHub, or pick another";
  return "Read the repository now";
}

function ReadCell({ binding, revoked, reading, read }: {
  binding: GitHubBinding | null;
  revoked: boolean;
  reading: boolean;
  read: { disabled: boolean; onRead: () => void } | null;
}) {
  // The header row is gone, so this cell carries its own name: a bare word
  // rather than a dash, because it is doing the header's job.
  const lastRead = binding?.lastReadAt ?? null;
  const unreadable = binding !== null && !binding.readable && !revoked;
  let when: ReactNode = "Never";
  if (reading) when = "Reading…";
  else if (unreadable) when = "Not visible";
  else if (lastRead && revoked) when = shortDate(lastRead);
  else if (lastRead) when = <RelativeTime value={lastRead} />;
  return (
    <span className="slack-routing-deliver">
      <em className="slack-routing-when" data-mark={unreadable && !reading ? "blocked" : undefined}>{when}</em>
      {binding && read ? (
        <button
          aria-label="Read the repository now"
          className="slack-test"
          data-tip={readTip(revoked, binding)}
          disabled={read.disabled}
          onClick={read.onRead}
          type="button"
        >
          <RefreshCw aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
}

/**
 * A row of the table. Choosing its repository saves it and reads it; the
 * read button only ever reads the repository already saved, so the row being
 * bound has none until its repository is saved and it becomes a bound row.
 */
export function GitHubRow(props: GitHubRowProps) {
  const { binding, revoked } = props;
  const disabled = !props.admin || revoked || props.busy;
  const current = binding ? binding.repository : null;
  return (
    <>
      <tr>
        <td>
          <ProjectCell binding={binding} choices={props.choices} disabled={disabled} onProject={props.onProject} projectId={props.projectId} />
        </td>
        <td>
          <RepositoryCell
            binding={binding}
            disabled={disabled || (!binding && !props.projectId)}
            onOpen={props.onOpen}
            onRepository={props.onRepository}
            options={repositoryOptions(props.repositories, current)}
            repositoryId={props.repositoryId}
          />
        </td>
        <td>
          <ReadCell
            binding={binding}
            read={props.admin ? { disabled, onRead: props.onRead } : null}
            reading={props.reading}
            revoked={revoked}
          />
        </td>
      </tr>
      {props.failure ? (
        <tr className="slack-save-failed">
          <td colSpan={3}><p className="inline-error" role="alert">{props.failure}</p></td>
        </tr>
      ) : null}
    </>
  );
}
