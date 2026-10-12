/**
 * A synthetic recording for the overlay's preview: a fictional invoicing app
 * walked for a little over three minutes and failing at the last step. Every
 * name, address and line here is made up; the shape is the one the shared
 * overlay module reads, which the recording view model maps into.
 */

import type { OverlayRecording } from "@shipbash/contracts/runtime/recording-overlay.mjs";
import { deriveBrowserRecordingChapters } from "../../../lib/client-contracts";

export const OVERLAY_FIXTURE_DURATION_MS = 185_000;

const narration = [
  { startMs: 0, endMs: 7_000, caption: "I’m opening Acme Invoices and signing in with the test account.", chapterId: "sign-in", chapterTitle: "Sign in" },
  { startMs: 15_000, endMs: 23_000, caption: "I’m signed in and on the dashboard. Next I’ll open Customers to add a new one.", chapterId: "customers", chapterTitle: "Open customers" },
  { startMs: 36_000, endMs: 44_000, caption: "The customer list loaded with 24 rows. I’m starting a new customer record.", chapterId: "new-customer", chapterTitle: "Create a customer" },
  { startMs: 58_000, endMs: 66_000, caption: "I filled in the name and billing email, and I’m checking the address with the API before saving.", chapterId: "new-customer", chapterTitle: "Create a customer" },
  { startMs: 73_000, endMs: 81_000, caption: "The customer was saved. I’m drafting an invoice for them from the Invoices page.", chapterId: "draft", chapterTitle: "Draft the invoice" },
  { startMs: 104_000, endMs: 112_000, caption: "I’m adding two line items: a design retainer and a hosting fee.", chapterId: "line-items", chapterTitle: "Add line items" },
  // As long as the agent writes them today: the overlay shows it in four pieces.
  { startMs: 124_000, endMs: 132_000, caption: "The total reads $1,240.00, which matches the design retainer and the hosting fee; tax is zero because the customer sits in an exempt region, and the due date is 30 days out, so I’ll send the invoice now.", chapterId: "line-items", chapterTitle: "Add line items" },
  { startMs: 138_000, endMs: 146_000, caption: "I pressed Send. The button spun and the invoice still says Draft, so I’m waiting for it to settle.", chapterId: "send", chapterTitle: "Send the invoice" },
  { startMs: 161_000, endMs: 169_000, caption: "I reloaded the invoice: it is still a Draft, and no confirmation email was queued.", chapterId: "send", chapterTitle: "Send the invoice" },
  { startMs: 176_000, endMs: 184_000, caption: "The invoice was never sent — Send left it in Draft and no email was queued.", chapterId: "result", chapterTitle: "Result" },
];

export const overlayFixture: OverlayRecording = {
  durationMs: OVERLAY_FIXTURE_DURATION_MS,
  // A chapter opens on its first line, exactly as the player derives it.
  chapters: deriveBrowserRecordingChapters(narration, OVERLAY_FIXTURE_DURATION_MS),
  cues: narration.map(({ startMs, endMs, caption }) => ({ startMs, endMs, caption })),
  pointers: [
    { atMs: 8_200 },
    { atMs: 14_100 },
    { atMs: 17_300 },
    { atMs: 40_200 },
    { atMs: 52_600 },
    { atMs: 70_400 },
    { atMs: 74_900 },
    { atMs: 107_800 },
    { atMs: 139_600 },
  ],
  attention: [
    { atMs: 0, surface: "browser", sessionId: null, label: null },
    { atMs: 60_500, surface: "terminal", sessionId: "term-demo-1", label: "curl -s https://api.example.com/v1/addresses/validate" },
    { atMs: 68_000, surface: "browser", sessionId: null, label: null },
    { atMs: 117_000, surface: "terminal", sessionId: "term-demo-2", label: "npm run seed:tax-rates" },
    { atMs: 123_000, surface: "browser", sessionId: null, label: null },
    { atMs: 163_500, surface: "terminal", sessionId: "term-demo-3", label: "tail -n 50 logs/mailer.log" },
    { atMs: 172_000, surface: "browser", sessionId: null, label: null },
  ],
};

/** The page the synthetic browser shows during each chapter. */
export const overlayFixturePages: Record<string, { nav: string; heading: string; action: string }> = {
  "sign-in": { nav: "Sign in", heading: "Welcome back", action: "Sign in" },
  customers: { nav: "Customers", heading: "Customers", action: "New customer" },
  "new-customer": { nav: "Customers", heading: "New customer", action: "Save customer" },
  draft: { nav: "Invoices", heading: "New invoice", action: "Add item" },
  "line-items": { nav: "Invoices", heading: "Invoice INV-0042", action: "Send invoice" },
  send: { nav: "Invoices", heading: "Invoice INV-0042 · Draft", action: "Sending…" },
  result: { nav: "Invoices", heading: "Invoice INV-0042 · Draft", action: "Send invoice" },
};
