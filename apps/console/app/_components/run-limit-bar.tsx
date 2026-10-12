"use client";

/**
 * Once the team has used the month's Runs, a slim bar across the top of every
 * page says so and when they come back: it is why Run now is off. It links to
 * Settings → Usage, except on that page.
 */
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { readQueryWhen } from "../../lib/web-client";
import { monthName, resetDay, runCount, runsExhausted } from "./usage-model";
import { useResolvedWorkspace } from "./workspace-session";

export function RunLimitBar() {
  const { workspace } = useResolvedWorkspace();
  const pathname = usePathname();
  const { data } = useQuery(readQueryWhen("runAllowance", workspace ? [workspace.team.id] : null));
  if (!workspace || !runsExhausted(data)) return null;
  const now = new Date();
  return (
    <div className="run-limit-bar" role="status">
      <span>All {runCount(data.quota)} for {monthName(now)} are used. Run now is off until {resetDay(now)}.</span>
      {pathname.endsWith("/settings/usage") ? null : <Link href={workspace.teamHref("/settings/usage")}>See usage</Link>}
    </div>
  );
}
