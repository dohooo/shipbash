"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { toast } from "sonner";

/**
 * The Activity page's long-lived attention toast: Cloudflare blocked product
 * access, and the trusted access that lets ShipBash through is one click away.
 */
export function useCloudflareBlockedToast({
  activityId,
  cloudflareBlocked,
  trustedAccessHref,
}: {
  activityId: string;
  cloudflareBlocked: boolean;
  trustedAccessHref: Route | null;
}) {
  const router = useRouter();
  useEffect(() => {
    if (!cloudflareBlocked || !trustedAccessHref) return;
    const toastId = `cloudflare-trusted-access-${activityId}`;
    toast.warning("Cloudflare blocked product access", {
      id: toastId,
      description: "Allow ShipBash through this project's Cloudflare challenge, then retry.",
      duration: Infinity,
      closeButton: true,
      action: {
        label: "Set up access",
        onClick: () => {
          toast.dismiss(toastId);
          router.push(trustedAccessHref);
        },
      },
    });
    return () => { toast.dismiss(toastId); };
  }, [activityId, cloudflareBlocked, router, trustedAccessHref]);
}
