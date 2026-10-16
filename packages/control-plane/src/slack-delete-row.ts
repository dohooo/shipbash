/**
 * The row at the foot of every message ShipBash posts in Slack: Delete, for
 * anyone who can see the message, once Slack has asked them to confirm.
 *
 * It is Slack's `context_actions` block, the one place a message carries
 * actions of its own under its content, and its trash icon is the only icon
 * Slack offers there. Slack does nothing with the press but tell the app
 * (`DELETE_MESSAGE_ACTION`, slack-chat/message-deletion.ts); a message posted
 * outside the channel — an ephemeral note only its reader sees — carries no
 * row, since it leaves on its own.
 */

/** The action the row's button sends, whichever message it sits under. */
export const DELETE_MESSAGE_ACTION = "shipbash:delete-message";

interface PlainText {
  type: "plain_text";
  text: string;
}

export interface DeleteRow {
  type: "context_actions";
  elements: [{
    type: "icon_button";
    icon: "trash";
    text: PlainText;
    action_id: string;
    accessibility_label: string;
    confirm: { title: PlainText; text: PlainText; confirm: PlainText; deny: PlainText; style: "danger" };
  }];
}

function plain(text: string): PlainText {
  return { type: "plain_text", text };
}

/** The row itself; it names no block id, so Slack gives each message's row a fresh one. */
function deleteRow(): DeleteRow {
  return {
    type: "context_actions",
    elements: [{
      type: "icon_button",
      icon: "trash",
      text: plain("Delete"),
      action_id: DELETE_MESSAGE_ACTION,
      accessibility_label: "Delete this message from ShipBash",
      confirm: {
        title: plain("Delete this message?"),
        text: plain("It is removed for everyone in this conversation."),
        confirm: plain("Delete"),
        deny: plain("Cancel"),
        style: "danger",
      },
    }],
  };
}

/**
 * A message's blocks with the row at their foot. A row they already carry —
 * the one Slack sends back with a message ShipBash draws again — is dropped
 * wherever it stood, so the row stays last under whatever the new drawing
 * adds, and goes out without the block id Slack gave it: Slack wants a new
 * one on every iteration of a message.
 */
export function withDeleteRow<Block extends { type: string }>(blocks: readonly Block[]): (Block | DeleteRow)[] {
  return [...blocks.filter((block) => block.type !== "context_actions"), deleteRow()];
}
