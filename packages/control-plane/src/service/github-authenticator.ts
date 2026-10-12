/** Settings manages credentials; verification runs only consume already-bound credentials. */
import type {
	AuthenticatorScope,
	AuthenticatorStore,
} from "../store/authenticators.ts";
import { normalizeTotpSecret } from "../store/authenticators.ts";
import type { AuthAttentionStore } from "../store/auth-attention.ts";
import { HttpError } from "./http-input.ts";

function validatedSecret(value:string):string {
  try { return normalizeTotpSecret(value); }
  catch (error) {
    throw new HttpError(400, "INVALID_TOTP_SECRET", error instanceof Error
      ? error.message : "Paste a Base32 setup key or an otpauth://totp link.");
  }
}

export function createGithubAuthenticatorGateway(input: {
	store: AuthenticatorStore;
	attention: AuthAttentionStore;
}) {
	async function read(scope: AuthenticatorScope) {
		const authenticator = await input.store.read(scope);
		return { authenticator, accountLogin: await input.store.accountLogin(scope) };
	}
	return {
		read,
    code: async (scope: AuthenticatorScope) => {
      const code = await input.store.currentCode(scope);
      if (!code) throw new HttpError(409, "AUTHENTICATOR_UNAVAILABLE", "No usable authenticator is configured for this sign-in.");
      return code;
    },
		/** The key is sealed under the account GitHub named when this session was saved. */
		save: async (scope: AuthenticatorScope, body: { secret: string }) => {
			if ((await input.store.save(scope, validatedSecret(body.secret))) === null)
				throw new HttpError(
					409,
					"GITHUB_ACCOUNT_UNKNOWN",
					"Sign in to GitHub again so ShipBash knows which account this sign-in belongs to.",
				);
			return read(scope);
		},
		remove: async (scope: AuthenticatorScope) => {
			await input.store.remove(scope);
		},
		attention: input.attention,
	};
}
export type GithubAuthenticatorGateway = ReturnType<
	typeof createGithubAuthenticatorGateway
>;
