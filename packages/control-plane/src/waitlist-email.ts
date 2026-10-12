/**
 * The one email the waiting list sends.
 *
 * There is exactly one, and the closing line promises that in so many words,
 * so a second send later is a copy change before it is a code change. The
 * markup is send-ready: nested presentation tables, fully
 * inline styles, no web fonts and no external stylesheet, because that is what
 * survives Gmail, Outlook and Apple Mail unchanged. Every text cell sets
 * `mso-line-height-rule: exactly`; without it Outlook ignores `line-height`.
 */

export interface WaitlistAdmissionEmailInput {
	/** The host of the site they asked us to bash, as the copy names it. */
	siteHost: string;
	/** The address they joined on, which is also the account they sign in with. */
	accountEmail: string;
	/** Straight into the product: `<public origin>/auth/login?next=%2F`. */
	signInUrl: string;
	/** Absolute, because an email client fetches it from nowhere near us. */
	markUrl: string;
}

export interface WaitlistAdmissionEmail {
	subject: string;
	html: string;
	text: string;
}

export const WAITLIST_ADMISSION_SUBJECT = "You're in — ShipBash";

/** What the reader pastes into a coding agent. The marketing site's landing page shows the same line. */
const SETUP_LINE =
	"Read shipbash.dev/setup.md and set up ShipBash for this project.";

/** Inline-styled markup interpolates untrusted text, so it is escaped here. */
function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function htmlBody(input: {
	siteHost: string;
	accountEmail: string;
	signInUrl: string;
	markUrl: string;
}): string {
	const { siteHost, accountEmail, signInUrl, markUrl } = input;
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="format-detection" content="telephone=no"><title>${escapeHtml(WAITLIST_ADMISSION_SUBJECT)}</title>
<style>
@media only screen and (max-width:660px){
  .wrap{width:100%!important}
  .pad{padding-left:30px!important;padding-right:30px!important}
  .h1{font-size:34px!important;line-height:40px!important}
  .lede{font-size:17px!important;line-height:28px!important}
  .line{padding:14px 16px!important;font-size:14px!important;line-height:22px!important}
}
</style>
</head>
<body style="margin:0;padding:0;background:#eceae5;">
<span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all;">A spot opened up. Paste one line into your coding agent and start bashing ${siteHost}.</span>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#eceae5;">
<tr><td align="center" style="padding:44px 16px;">

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="640" class="wrap" style="width:640px;max-width:640px;">

<!-- Brand lockup, outside the sheet so it reads as the sender. -->
<tr><td class="pad" style="padding:0 8px 18px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="34" style="width:34px;padding-right:11px;vertical-align:middle;"><img src="${markUrl}" width="34" height="34" alt="ShipBash" style="display:block;width:34px;height:34px;border:0;"></td>
<td style="vertical-align:middle;font-family:Helvetica,Arial,sans-serif;font-size:21px;font-weight:bold;line-height:26px;mso-line-height-rule:exactly;letter-spacing:-0.5px;color:#141414;">ShipBash</td>
</tr></table>
</td></tr>

<!-- The body. -->
<tr><td style="background:#f7f5f2;border:1px solid #ddd8d0;border-radius:16px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">

<tr><td class="pad h1" style="padding:46px 52px 0;font-family:Helvetica,Arial,sans-serif;font-size:40px;font-weight:bold;line-height:46px;mso-line-height-rule:exactly;letter-spacing:-1.2px;color:#141414;">You're in.</td></tr>

<tr><td class="pad lede" style="padding:20px 52px 0;font-family:Helvetica,Arial,sans-serif;font-size:18px;line-height:30px;mso-line-height-rule:exactly;color:#55504a;">A spot opened up on the waitlist, and <span style="color:#141414;font-weight:bold;">${siteHost}</span> is ready to bash. Paste this into your coding agent (Claude Code, Codex or Cursor):</td></tr>

<!-- The line to paste. No mail client runs a copy button's script, so one click selects the whole line where the client keeps user-select. -->
<tr><td class="pad" style="padding:22px 52px 0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
<td class="line" style="padding:18px 22px;background:#fdfcfa;border:2px dashed #141414;border-radius:14px;-webkit-user-select:all;user-select:all;font-family:ui-monospace,Menlo,Consolas,'Courier New',monospace;font-size:16px;line-height:26px;mso-line-height-rule:exactly;color:#141414;">${SETUP_LINE}</td>
</tr></table>
</td></tr>

<tr><td class="pad" style="padding:22px 52px 0;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:24px;mso-line-height-rule:exactly;">
<a href="${signInUrl}" style="color:#141414;font-weight:bold;text-decoration:underline;text-underline-offset:3px;">Or open ShipBash in the browser&nbsp;&rarr;</a>
</td></tr>

<tr><td class="pad" style="padding:20px 52px 0;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:26px;mso-line-height-rule:exactly;color:#7a746c;">Either way, sign in with the account you joined on — <span style="color:#141414;">${accountEmail}</span>.</td></tr>

<tr><td class="pad" style="padding:38px 52px 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td height="1" style="height:1px;line-height:1px;font-size:0;background:#ddd8d0;">&nbsp;</td></tr></table></td></tr>

<tr><td class="pad" style="padding:26px 52px 44px;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:24px;mso-line-height-rule:exactly;color:#8d877e;">
This is the one email we said we'd send, so there's nothing to unsubscribe from — you won't hear from us again unless you write first.
</td></tr>

</table>
</td></tr>

<!-- Sender line, outside the sheet. -->
<tr><td class="pad" style="padding:22px 8px 0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:22px;mso-line-height-rule:exactly;color:#8d877e;">
ShipBash · shipbash.dev
</td></tr>

</table>
</td></tr>
</table>
</body></html>
`;
}

/** The same words, for a client that will not render the markup. */
function textBody(input: {
	siteHost: string;
	accountEmail: string;
	signInUrl: string;
}): string {
	return [
		"You're in.",
		"",
		`A spot opened up on the waitlist, and ${input.siteHost} is ready to bash. Paste this into your coding agent (Claude Code, Codex or Cursor):`,
		"",
		SETUP_LINE,
		"",
		"Or open ShipBash in the browser:",
		input.signInUrl,
		"",
		`Either way, sign in with the account you joined on — ${input.accountEmail}.`,
		"",
		"This is the one email we said we'd send, so there's nothing to unsubscribe from — you won't hear from us again unless you write first.",
		"",
		"ShipBash · shipbash.dev",
		"",
	].join("\n");
}

export function renderWaitlistAdmissionEmail(
	input: WaitlistAdmissionEmailInput,
): WaitlistAdmissionEmail {
	return {
		subject: WAITLIST_ADMISSION_SUBJECT,
		html: htmlBody({
			siteHost: escapeHtml(input.siteHost),
			accountEmail: escapeHtml(input.accountEmail),
			signInUrl: escapeHtml(input.signInUrl),
			markUrl: escapeHtml(input.markUrl),
		}),
		text: textBody(input),
	};
}
