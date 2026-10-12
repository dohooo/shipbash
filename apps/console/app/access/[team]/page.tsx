import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";

import { teamAccessGateContract } from "../../../lib/api-contracts";
import { safeSameSitePath } from "@shipbash/contracts/same-site-path";
import { serverLoad } from "../../../lib/server-client";
import { getVerifiedUser } from "../../../lib/supabase/server";
import { AuthPageLoading } from "../../_components/auth-page-loading";
import { route } from "../../_lib/route";
import { AccessGate } from "./access-gate";

export const metadata: Metadata = { title: "Request access" };

interface AccessPageProps {
  params: Promise<{ team: string }>;
  searchParams: Promise<{ next?: string | string[] }>;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

/**
 * The wall an evidence link puts a non-member against, and the one way
 * through it. What this page may say about the Team is what the store agreed
 * to disclose — its name, and who administers it by display name. The project
 * and the run stay out of it: the reader is asking for a Team, not for a run.
 */
async function AccessContent({ params, searchParams }: AccessPageProps) {
  await connection();
  const { team } = await params;
  const next = safeSameSitePath(firstValue((await searchParams).next));
  const here = `/access/${encodeURIComponent(team)}?next=${encodeURIComponent(next)}`;
  const user = await getVerifiedUser();
  if (!user) redirect(route(`/login?next=${encodeURIComponent(here)}`));

  const gate = await serverLoad(teamAccessGateContract, { params: { team } }).catch(() => null);
  if (!gate) notFound();
  // Approved while this was open: the link the reader came with now works.
  if (gate.access === "member") redirect(route(next));

  return (
    <AccessGate
      account={user.email ?? user.user_metadata?.user_name ?? "your account"}
      adminNames={gate.adminNames}
      requestedAt={gate.requestedAt}
      returnTo={next}
      team={team}
      teamName={gate.teamName}
    />
  );
}

export default function AccessPage(props: AccessPageProps) {
  return (
    <Suspense
      fallback={<AuthPageLoading />}
    >
      <AccessContent {...props} />
    </Suspense>
  );
}
