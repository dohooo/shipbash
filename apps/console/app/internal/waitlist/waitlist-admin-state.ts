/** The internal list's action state, shared by the forms and the actions. */
export interface WaitlistAdminState {
	/** Bumped when a decision is answered, which is what closes the dialog. */
	attempt: number;
	error: string | null;
}

export const INITIAL_WAITLIST_ADMIN_STATE: WaitlistAdminState = {
	attempt: 0,
	error: null,
};
