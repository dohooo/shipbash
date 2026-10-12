import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "ShipBash Lockups",
  robots: { index: false, follow: false },
};

export default function LockupsPage() {
  redirect("/brand#assets");
}
