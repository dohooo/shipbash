"use client";

import { RouteError } from "./_components/route-error";

export default function ErrorPage({ error, retry }: Readonly<{ error: Error & { digest?: string }; retry: () => void }>) {
  return <RouteError error={error} retry={retry} />;
}
