/** First-run consent disclosure for the pi-crew (baphuongna) provider.
 *
 *  The consent gate ships these strings verbatim to the Intro tour so no
 *  client-side copy can drift. The headline titles the ask; the disclosure
 *  is its body (what is written, what data moves, how to undo). */

export const PI_CREW_CONSENT_HEADLINE = 'Enable pi-crew';

export const PI_CREW_CONSENT_DISCLOSURE = `Pixel Agents will read your project's pi-crew run events (.crew/state/runs/*/events.jsonl)
to visualize your pi-crew agents (planner, workers, reviewers) as pixel-art characters
in the office.

Each pi-crew worker gets its own character that shows its current task and role.
Task progress, blocks, and completions are reflected in real time.

No data is sent anywhere. The event log is read locally from your project directory. If a
local read or delivery fails, Pixel Agents keeps a bounded diagnostic record with project/run
metadata for troubleshooting; it never includes your hook bearer token.

You can disable this at any time from the Settings panel.`;
