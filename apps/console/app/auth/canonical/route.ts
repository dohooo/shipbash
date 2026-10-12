import type { NextRequest, NextResponse } from "next/server";

import { safeSameSitePath } from "@shipbash/contracts/same-site-path";
import { publicOrigin } from "../../../lib/public-origin";
import { redirectResponse } from "../_lib";

function canonicalNext(value: string | null): string {
  const next = safeSameSitePath(value);
  const pathname = new URL(next, "http://local.invalid").pathname;
  return pathname === "/auth/canonical" ? "/" : next;
}

export function GET(request: NextRequest): NextResponse {
  return redirectResponse(new URL(canonicalNext(request.nextUrl.searchParams.get("next")), publicOrigin()));
}
