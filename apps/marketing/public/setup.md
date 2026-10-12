# Set up ShipBash

ShipBash is open-source AI QA for a web app or CLI on production: it uses the product like a real user, keeps the journeys that matter, and re-runs them on a schedule. You set it up from this terminal. The ShipBash web page is the main stage: the user watches and acts there; you narrate and prompt.

Run every command as `npx shipbash@latest <command>` (agent mode is automatic; add --json if it prints text). Never ask for, type or store the user's passwords for their product.

When a command exits non-zero with `nextSteps`, follow them unless this guide says otherwise (drafts, for example, are kept on the page). Without `nextSteps`, show its message and stop.

## 1. Connect the account

1. Run `login`. It opens the browser and prints a link and a code.
2. Tell the user: "I opened ShipBash in your browser. Check it shows <code>, then click Approve." Give the link in case the browser did not open.
3. Run `login` again while it says it is still waiting for approval. If it is still waiting after the user says they are done, ask what the page shows. If it says they are on the waitlist: tell them the approval email will contain this same line, and stop.
4. If `login` says the code expired, run `login` again for a fresh code and go back to step 2.

## 2. Add the product

1. Ask the user for the URL of their live product.
2. Run `projects add <url>`. Keep the project ref it prints.

## 3. Find the journeys

1. Run `journeys add --project <ref> --timeout 0`. It starts discovery and returns at once with the walk and its link.
2. Give the user the link: they watch ShipBash explore there.
3. Repeat `journeys wait <walk> --project <ref>`. After each return, tell the user in one or two sentences what ShipBash is doing.
   - Sign-in needed: tell them to sign in on that page. When they say it is done, keep waiting.
   - A question: relay it; answer with `journeys answer <walk> "<answer>" --project <ref>`, or tell them to answer on the page. Then keep waiting.
   - Drafts ready: tell them to review and keep them on the page. Go on when they say they have.
   - If `journeys wait` says the drafts were already kept or discarded, the user decided on the page: go on to step 4.

## 4. Schedule and first run

1. Run `journeys schedule set daily 02:00 --project <ref>` (once a day, at 02:00 on this machine's clock) unless the user wants another cadence.
2. Run `journeys run --project <ref>`. While it reports the verification still running, repeat `verifications wait <verification> --project <ref>`. Report the verdict and its link.

## Done

Install the skill so later sessions know ShipBash: `npx skills add dohooo/shipbash-skills`. Summarize what is set up, with links.
