/**
 * How long a sign-in check is allowed to take, and how long its leavings are
 * allowed to look alive.
 *
 * These two numbers are shared by the lane that runs a leg and the reaper that
 * settles rows no leg came back from, and the reaper is reached from the API
 * routes the console bundles. The lane is not: it opens containers, so its
 * module graph reaches the host's Docker glue and the file-URL lookups that go
 * with it, which the console build cannot resolve. So the numbers live here, in
 * a leaf that imports nothing, and both sides read them from here rather than
 * from each other.
 */

/** A leg that has not spoken by now proved nothing, and the sign-in stays unticked. */
export const SIGN_IN_VERIFY_TIMEOUT_MS = 3 * 60_000;

/**
 * How old something must be before no leg could still be behind it: past the
 * longest a leg may run, with a minute's grace for a host that was busy when
 * the leg's own teardown should have happened.
 *
 * It decides two things, for the same reason. A row still saying `verifying`
 * this long after its last touch has nobody checking it, and an attempt
 * directory this old belongs to no check still running.
 */
export const SIGN_IN_VERIFY_STRANDED_AFTER_MS = SIGN_IN_VERIFY_TIMEOUT_MS + 60_000;
