import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { InvitationAcceptance } from "../../_components/invitation";
import { SectionLoading } from "../../_components/shell";

export const metadata: Metadata = { title: "Join team" };

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

async function InvitationContent({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!TOKEN_PATTERN.test(token)) notFound();
  return (
    <main className="auth-page">
      <InvitationAcceptance token={token} />
    </main>
  );
}

export default function InvitationPage(props: { params: Promise<{ token: string }> }) {
  return (
    <Suspense fallback={<main className="auth-page"><SectionLoading /></main>}>
      <InvitationContent {...props} />
    </Suspense>
  );
}
