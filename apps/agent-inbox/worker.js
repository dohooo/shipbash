// Receives mail for the addresses agents use to sign up on the products they test.
// Cloudflare setup: Email Routing on the zone apex, the apex catch-all rule sends to
// this Worker, and the inbox subdomain is added under Email Routing > Subdomains. The
// apex catch-all also receives mail for every subdomain without a literal rule.
// Not deployed by releases; nothing reads the stored mail.

const KEEP_SECONDS = 60 * 60 * 24 * 7;

export default {
  async email(message, env) {
    const to = message.to.toLowerCase();
    if (!to.endsWith(`@${env.INBOX_DOMAIN}`)) {
      message.setReject("Address not accepted");
      return;
    }
    const raw = await new Response(message.raw).text();
    await env.INBOX.put(`${to}/${Date.now()}`, raw, {
      expirationTtl: KEEP_SECONDS,
      metadata: {
        from: message.from,
        to,
        subject: message.headers.get("subject"),
        size: message.rawSize,
      },
    });
  },
};
