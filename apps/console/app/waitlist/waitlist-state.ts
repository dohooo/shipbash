/** The Join form's state, shared by the server action and the form it feeds. */
export interface JoinWaitlistState {
	/**
	 * Bumped on every answered submission. The form is keyed on it, so a refused
	 * ask comes back carrying what the reader typed rather than what the page
	 * first rendered.
	 */
	attempt: number;
	email: string;
	site: string;
	/** `site` gets the designed sentence and marks the field; anything else is quoted. */
	error: "site" | "other" | null;
	message: string | null;
}

export function initialJoinWaitlistState(email: string): JoinWaitlistState {
	return { attempt: 0, email, site: "", error: null, message: null };
}
