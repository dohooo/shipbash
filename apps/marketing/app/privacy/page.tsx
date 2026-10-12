import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy — ShipBash",
  description: "What ShipBash collects, why, who processes it, and how to have it deleted.",
};

export default function PrivacyPage() {
  return (
    <main className="legal-page">
      <a className="legal-home" href="/">ShipBash</a>
      <h1>Privacy</h1>
      <p className="legal-updated">Last updated October 3, 2026</p>

      <p>
        ShipBash tests your web app or CLI the way your users use it and reports what breaks. This page says what
        we collect to do that, why, who handles it for us, and how to have it deleted. Questions go to{" "}
        <a href="mailto:hello@shipbash.dev">hello@shipbash.dev</a>.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Your account.</strong> When you sign in with GitHub or Google we receive your name, email address
          and profile picture, plus your GitHub username and ID, or, for a Google Workspace account, its domain.
        </li>
        <li>
          <strong>Waiting list.</strong> The email address and site address you give us when you ask to join.
        </li>
        <li>
          <strong>Your product and its tests.</strong> The addresses, journeys and notes you give ShipBash, and what
          its runs produce: recordings, screenshots, logs and reports of your product. Sign-in details you give
          ShipBash for the product it tests are stored encrypted.
        </li>
        <li>
          <strong>Connections you choose.</strong> If you connect them: your GitHub repositories (read-only) and a
          Slack channel for alerts.
        </li>
      </ul>

      <h2>How we use it</h2>
      <p>
        Only to run ShipBash for you: to sign you in, show you to your teammates, run and report your tests, and
        send the emails and alerts you asked for. If you sign in with a Google Workspace account, its domain puts
        you in your company&apos;s team on ShipBash, alongside the colleagues who signed in the same way. We do
        not sell your data, show ads, or use it to train models.
      </p>
      <p>
        ShipBash&apos;s use of information received from Google APIs adheres to the{" "}
        <a href="https://developers.google.com/terms/api-services-user-data-policy">
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements. From Google we receive only your name, email address, profile
        picture and Workspace domain, and use them only to sign you in and to put you in your company&apos;s
        team.
      </p>

      <h2>Who handles it for us</h2>
      <ul>
        <li>Supabase: database, sign-in and file storage.</li>
        <li>Vercel: hosting, and the isolated machines tests run on.</li>
        <li>OpenAI: the models behind ShipBash&apos;s agents. What an agent sees of your product while testing it
          is sent to them.</li>
        <li>Resend: email.</li>
        <li>GitHub, Google and Slack: sign-in and the connections you choose.</li>
      </ul>

      <h2>Cookies</h2>
      <p>ShipBash sets only the cookies that keep you signed in. There are no analytics or advertising cookies.</p>

      <h2>Keeping and deleting</h2>
      <p>
        We keep your data while your account is in use. To have your account and its data deleted, write to{" "}
        <a href="mailto:hello@shipbash.dev">hello@shipbash.dev</a> from the email address you sign in with.
      </p>

      <h2>Changes</h2>
      <p>When this page changes, the date at the top changes with it.</p>
    </main>
  );
}
