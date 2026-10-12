import { getPublicVerificationContract } from "@shipbash/contracts/api/public-verifications";
import { serverLoad } from "@/lib/server-client";
import { SHARE_CARD_SIZE, shareCardImage } from "../../../_components/share-card-image";
import { shareCard } from "../../../_lib/share-card";

export const alt = "ShipBash verification result";
export const size = SHARE_CARD_SIZE;
export const contentType = "image/png";

export default async function Image({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // Read the way the crawler that asked for this image reads it: through the
  // public handler, as an anonymous stranger who may only see a published run.
  const verification = await serverLoad(getPublicVerificationContract, { params: { token } })
    .then((shared) => shared.verification, () => null);
  const card = verification && shareCard(verification, new Date());
  // An unknown, revoked or unfinished run has no verdict to assert, so it gets
  // no image at all rather than a card claiming something the run never said.
  if (!card) return new Response(null, { status: 404 });
  return shareCardImage(card);
}
