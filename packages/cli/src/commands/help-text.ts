/** Help text more than one command's --help carries. */
export const TIMEOUT = `  --timeout <seconds>  Stop waiting after this long and exit 3. 0 returns at once.`;

/** Where an agent finds the page of a walk it waits for. */
export const WALK_PAGE = `In agent mode the JSON names the walk and its page in the console (url),
where the user can watch it.`;

export const WAITING = `Waiting: a walk takes minutes. The walk id is printed first and progress goes
to stderr. Ctrl-C or --timeout stops the waiting, not the walk; pick it up with
\`shipbash journeys wait <walk>\`. Agent mode waits 90s per call.
${WALK_PAGE}`;
