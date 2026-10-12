"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { ApiError, readQuery } from "../../lib/web-client";
import { QueryError, SectionLoading } from "./shell";
import { scopePath } from "./workspace-address";

/**
 * Resolves the reader's default scope and replaces the root with that address,
 * so the URL they end up on names the workspace they are looking at. The choice
 * is the session's: its active team, or the first one it can see.
 */
export function RootScopeRedirect() {
  const router = useRouter();
  const query = useQuery(readQuery("session", null));
  const session = query.data;
  const team = session?.teams.find((candidate) => candidate.id === session.activeTeamId)
    ?? session?.teams[0]
    ?? null;
  const project = team
    ? session?.projects.find((candidate) => candidate.teamId === team.id) ?? null
    : null;

  useEffect(() => {
    if (!team) return;
    // Born canonical: the address is written in slugs from the start, so the
    // reader never sees a UUID hop that ScopeAddress has to rewrite.
    router.replace(scopePath(team.slug, project?.slug ?? null));
  }, [project?.slug, router, team]);

  if (query.isLoadingError) {
    const unauthorized = query.error instanceof ApiError && query.error.status === 401;
    return (
      <main className="standalone-state">
        <QueryError
          error={query.error}
          retry={() => void query.refetch()}
          action={unauthorized ? <Link className="button primary" href="/login">Sign in</Link> : undefined}
        />
      </main>
    );
  }
  if (session && !team) {
    return <main className="standalone-state"><div className="state">No Team is available.</div></main>;
  }
  return <main className="standalone-state"><SectionLoading /></main>;
}
