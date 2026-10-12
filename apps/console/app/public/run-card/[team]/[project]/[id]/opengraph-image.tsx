import { SHARE_CARD_SIZE, shareCardImage } from "@/app/_components/share-card-image";
import { cardFromFacts } from "@/app/_lib/share-card";
import { type RunAddress, readRunCard } from "./run-card";

export const alt = "ShipBash verification result";
export const size = SHARE_CARD_SIZE;
export const contentType = "image/png";

export default async function Image({ params }: { params: Promise<RunAddress> }) {
  const facts = await readRunCard(await params);
  // An unknown, unfinished or blocked run has no verdict to assert, so it gets
  // no image at all rather than a card claiming something the run never said.
  if (!facts) return new Response(null, { status: 404 });
  return shareCardImage(cardFromFacts(facts, new Date()));
}
