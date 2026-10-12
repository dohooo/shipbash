"use client";

/**
 * One row of the routing table, in the only two shapes it has: one channel a
 * project already alerts into, or the one being added. A row that exists is
 * fixed — its project and channel are names, and what it offers is a test of
 * that channel and its removal; moving a project to another channel is adding
 * the new one and removing the old. The row being added is the same row with
 * both names still choices and nothing saved to test or remove, which is why
 * there is one row component and not two.
 */
import { Lock, Send, X } from "lucide-react";
import type { ReactNode } from "react";

import type {
  Project,
  SlackChannel,
  SlackChannelBinding,
  SlackDeliveryError,
} from "../../lib/web-client";
import { RelativeTime } from "./relative-time";
import { channelLabel, deliveryFault } from "./slack-attention";
import { projectMark } from "./workspace-marks";

/** One of a saved row's two buttons: what it is called, what its tip says, and what it does. */
interface RowAction {
  label: string;
  tip: string;
  disabled: boolean;
  onClick: () => void;
}

function RowButton({ action, className, children }: {
  action: RowAction;
  className: string;
  children: ReactNode;
}) {
  return (
    <button
      aria-label={action.label}
      className={className}
      data-tip={action.tip}
      disabled={action.disabled}
      onClick={action.onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function DeliveryCell({ binding, actions }: {
  binding: SlackChannelBinding | null;
  actions: { test: RowAction; remove: RowAction } | null;
}) {
  // The header row is gone, so this cell carries its own name: a bare word
  // rather than a dash, because it is doing the header's job.
  const fault = binding?.deliveryError ?? null;
  const reads = fault ? deliveryFault(fault).reads : null;
  const delivered = !fault && binding?.lastDeliveredAt ? binding.lastDeliveredAt : null;
  return (
    <span className="slack-routing-deliver">
      <em className="slack-routing-when" data-mark={fault ? "blocked" : undefined}>
        {reads}
        {delivered ? <RelativeTime value={delivered} /> : null}
        {!reads && !delivered ? "Never" : null}
      </em>
      {actions ? (
        <>
          <RowButton action={actions.test} className="slack-test"><Send aria-hidden="true" /></RowButton>
          <RowButton action={actions.remove} className="slack-remove"><X aria-hidden="true" /></RowButton>
        </>
      ) : null}
    </span>
  );
}

export interface RowProps {
  /** The channel this row draws, or null while the row is the one being added. */
  binding: SlackChannelBinding | null;
  /** Only the row being added offers these: every live project of the team. */
  choices: readonly Project[];
  /** The channels the row being added may pick: none its project already alerts into. */
  channels: readonly SlackChannel[];
  projectId: string;
  channelId: string;
  /** Why the last channel chosen in this row was not added, said under the row. */
  failure: string | null;
  /** A member reads the row; only an admin may add, test or remove. */
  admin: boolean;
  /** Every row goes inert together, and the delivery times freeze where they are. */
  revoked: boolean;
  busy: boolean;
  onProject: (projectId: string) => void;
  onChannel: (channelId: string) => void;
  /** This row's channel select was opened; the channel list is read then and not before. */
  onOpen: () => void;
  onTest: () => void;
  onRemove: () => void;
}

function ProjectCell({ binding, choices, projectId, disabled, onProject }: Pick<
  RowProps,
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
      <select
        aria-label="Project"
        disabled={disabled}
        onChange={(event) => onProject(event.target.value)}
        value={projectId}
      >
        <option value="">Pick a project…</option>
        {choices.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </select>
    </label>
  );
}

/** A saved channel is a name, not a control: a lock says it is private, where `#` says it is not. */
function ChannelCell({ binding, channels, channelId, disabled, onChannel, onOpen }: Pick<
  RowProps,
  "binding" | "channels" | "channelId" | "onChannel" | "onOpen"
> & { disabled: boolean }) {
  if (binding) {
    const { channel } = binding;
    return (
      <span className="slack-routing-channel">
        {channel.isPrivate ? <Lock aria-hidden="true" /> : null}
        {channel.isPrivate ? channel.name : `#${channel.name}`}
        {channel.isPrivate ? <span className="sr-only"> (private)</span> : null}
      </span>
    );
  }
  return (
    <label className="form-field">
      <select
        aria-label="Notification channel"
        disabled={disabled}
        onChange={(event) => onChannel(event.target.value)}
        onFocus={onOpen}
        value={channelId}
      >
        <option value="">Pick a notification channel…</option>
        {channels.map((channel) => (
          <option key={channel.id} value={channel.id}>{channelLabel(channel)}</option>
        ))}
      </select>
    </label>
  );
}

function testTip(input: {
  revoked: boolean;
  fault: SlackDeliveryError | null;
  label: string;
}): string {
  if (input.revoked) return `Reconnect Slack to test ${input.label}`;
  // The row is the one place a test was actually run, so it is the one place
  // that may say a test failed; the instruction after it is shared.
  if (input.fault) return `Test failed — ${deliveryFault(input.fault).fix}`;
  return `Send a test message to ${input.label}`;
}

/** A saved row's test and removal, each named by its project and channel, since a channel may serve several projects. */
function rowActions(props: RowProps, binding: SlackChannelBinding, disabled: boolean) {
  const label = channelLabel(binding.channel);
  return {
    test: {
      label: `Send a test message to ${label} for ${binding.projectName}`,
      tip: testTip({ revoked: props.revoked, fault: binding.deliveryError, label }),
      disabled,
      onClick: props.onTest,
    },
    remove: {
      label: `Remove ${label} from ${binding.projectName}`,
      tip: `Remove ${label}`,
      disabled,
      onClick: props.onRemove,
    },
  };
}

/**
 * A row of the routing table, in the only two shapes it has: a channel a
 * project already alerts into, or the one being added. Choosing the added
 * row's channel saves it; the test only ever reaches a channel saved, so the
 * row being added has none until its channel is saved and it becomes a row of
 * its own.
 */
export function RoutingRow(props: RowProps) {
  const { binding } = props;
  const disabled = !props.admin || props.revoked || props.busy;
  return (
    <>
      <tr>
        <td>
          <ProjectCell
            binding={binding}
            choices={props.choices}
            disabled={disabled}
            onProject={props.onProject}
            projectId={props.projectId}
          />
        </td>
        <td>
          <ChannelCell
            binding={binding}
            channelId={props.channelId}
            channels={props.channels}
            // The row being added saves on its channel, so it names its project first.
            disabled={disabled || !props.projectId}
            onChannel={props.onChannel}
            onOpen={props.onOpen}
          />
        </td>
        <td>
          <DeliveryCell
            actions={props.admin && binding ? rowActions(props, binding, disabled) : null}
            binding={binding}
          />
        </td>
      </tr>
      {/* Under the row and across it: the reason and its fix are a sentence,
          and beside the select they would squeeze every column of the table. */}
      {props.failure ? (
        <tr className="slack-save-failed">
          <td colSpan={3}><p className="inline-error" role="alert">{props.failure}</p></td>
        </tr>
      ) : null}
    </>
  );
}
