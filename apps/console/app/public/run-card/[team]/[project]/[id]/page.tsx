/**
 * A private run's page as someone without a session reaches it: the proxy
 * rewrites the run's own address here, so a Slack unfurl of it shows the run's
 * card. The body reuses the login page; the run stays behind sign-in.
 */
import type { Metadata } from "next";
import { Suspense } from "react";

import { safeSameSitePath } from "@shipbash/contracts/same-site-path";
import { AuthPageLoading } from "@/app/_components/auth-page-loading";
import { cardFromFacts } from "@/app/_lib/share-card";
import { LoginContent } from "@/app/login/page";
import { type RunAddress, readRunCard } from "./run-card";

interface RunCardPageProps {
  params: Promise<RunAddress>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const NO_CARD_TITLE = "ShipBash verification run";
const NO_CARD_DESCRIPTION = "Sign in to see this run.";

/**
 * What a run with no card says, whether it is unknown, unfinished or blocked:
 * the same words, and no image (`opengraph-image` answers 404 for it).
 */
const NO_CARD: Metadata = {
  title: { absolute: NO_CARD_TITLE },
  description: NO_CARD_DESCRIPTION,
  robots: { index: false, follow: false },
  openGraph: { title: NO_CARD_TITLE, description: NO_CARD_DESCRIPTION, siteName: "ShipBash", type: "website", images: [] },
  twitter: { card: "summary_large_image", title: NO_CARD_TITLE, description: NO_CARD_DESCRIPTION, images: [] },
};

export async function generateMetadata({ params }: RunCardPageProps): Promise<Metadata> {
  const facts = await readRunCard(await params);
  if (!facts) return NO_CARD;
  const { footerName: title, footerStamp } = cardFromFacts(facts, new Date());
  const description = `ShipBash verification run · ${footerStamp}. Sign in to see the evidence.`;
  return {
    title,
    description,
    robots: { index: false, follow: false },
    openGraph: { title, description, siteName: "ShipBash", type: "website" },
    twitter: { card: "summary_large_image", title, description },
  };
}

/** The shared login screen, returning to the run and whatever it asked to open. */
async function SignIn({ params, searchParams }: RunCardPageProps) {
  const { team, project, id } = await params;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const each of [value ?? []].flat()) query.append(key, each);
  }
  const path = `/${[team, project, "verifications", id].map(encodeURIComponent).join("/")}`;
  const next = safeSameSitePath(query.size > 0 ? `${path}?${query.toString()}` : path);
  return <LoginContent searchParams={Promise.resolve({ next })} />;
}

export default function RunCardPage(props: RunCardPageProps) {
  return (
    <Suspense fallback={<AuthPageLoading />}>
      <SignIn {...props} />
    </Suspense>
  );
}
