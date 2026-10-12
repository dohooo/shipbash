import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn-style class combiner used by the AI Elements components. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
