import type { TeamSignIn, TeamSignInMethod } from "../../lib/web-client";
import { BRAND_MARKS, METHOD_NAMES, PASSWORD_METHOD } from "./sign-in-methods";
import type { Binding } from "./use-sign-in-binding";

/**
 * What the list says about itself, which is the only place this step explains
 * anything. The consequence of skipping is stated here rather than in the
 * bottom bar: this is the moment it applies, and a bar of facts is no place
 * for a sentence of prose.
 */

const PICK_LEDE = "Save a way in and it tries that itself. Skip, and the first run stops at the wall and hands you the browser — either way you are never locked out.";
const WATCHING_LEDE = "You have the browser. ShipBash is watching, not driving.";
const FINISH_LEDE = "Finish in the browser, then press I'm done.";
const VERIFY_LEDE = "ShipBash is checking that this sign-in works.";
const PASSWORD_LEDE = "ShipBash types this one in itself. If it cannot get through, it stops and hands you the browser.";
const SAVED_LEDE = "Saved for the team, and used by this project — binding it here is what that means.";
const PAIR_LEDE = "A broken Google button never blocks the walk — the password is the other way in.";

const COUNTS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"];

/**
 * The article goes by sound, not by spelling: `SSO` opens on an "ess", and the
 * two names that open on a vowel letter open on a vowel sound too. A rule read
 * off the first letter would say "a SSO" and "an Any login page" is the half it
 * would get right by accident.
 */
const VOWEL_SOUND_METHODS = new Set<TeamSignInMethod>(["any_login_page", "apple", "sso"]);

interface RailHead {
  title: string;
  lede: string;
}

function savedTitle(count: number): string {
  const word = COUNTS[count] ?? String(count);
  return `${word} way${count === 1 ? "" : "s"} in saved`;
}

/**
 * The pair sentence is only true of the pair it names: a third-party button
 * that can break, and a password that does not go through it. Said over any
 * other pair it would be misinforming, so every other set keeps the sentence
 * that is true of all of them.
 */
function savedLede(saved: readonly TeamSignIn[]): string {
  const brand = saved.some((signIn) => Boolean(BRAND_MARKS[signIn.method]));
  const password = saved.some((signIn) => signIn.method === PASSWORD_METHOD);
  return saved.length === 2 && brand && password ? PAIR_LEDE : SAVED_LEDE;
}

export function railHead(binding: Binding | null, saved: readonly TeamSignIn[], host: string): RailHead {
  if (binding && binding.phase !== "done") {
    const name = METHOD_NAMES[binding.method];
    if (binding.phase === "verifying") return { title: `Checking the ${name} sign-in`, lede: VERIFY_LEDE };
    if (binding.method === PASSWORD_METHOD) return { title: name, lede: PASSWORD_LEDE };
    const lede = binding.touched ? FINISH_LEDE : WATCHING_LEDE;
    if (binding.signInId) return { title: `Signing in again · ${name}`, lede };
    const article = VOWEL_SOUND_METHODS.has(binding.method) ? "an" : "a";
    return { title: `Adding ${article} ${name} sign-in`, lede };
  }
  if (saved.length === 0) return { title: `How does ShipBash get into ${host}?`, lede: PICK_LEDE };
  return { title: savedTitle(saved.length), lede: savedLede(saved) };
}
