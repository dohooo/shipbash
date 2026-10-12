"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Toaster } from "sonner";

import { TooltipProvider } from "../components/ui/tooltip";
import { getQueryClient } from "../lib/query-client";

export function Providers({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <QueryClientProvider client={getQueryClient()}>
      <TooltipProvider>{children}</TooltipProvider>
      <Toaster
        className="shipbash-toaster"
        position="bottom-right"
        expand={false}
        visibleToasts={4}
        gap={8}
        offset={18}
        duration={4_000}
        toastOptions={{ className: "shipbash-toast" }}
      />
    </QueryClientProvider>
  );
}
