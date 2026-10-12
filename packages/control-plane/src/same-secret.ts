import { timingSafeEqual } from "node:crypto";

/** Length-independent, so a wrong password never answers faster than a right one. */
export function sameSecret(presented: string, configured: string): boolean {
	const left = Buffer.from(presented, "utf8");
	const right = Buffer.from(configured, "utf8");
	return left.length === right.length && timingSafeEqual(left, right);
}
