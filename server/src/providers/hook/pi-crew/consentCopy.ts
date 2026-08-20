/** First-run consent disclosure for the pi-messenger Crew provider.
 *
 *  The consent gate ships these strings verbatim to the Intro tour so no
 *  client-side copy can drift. The headline titles the ask; the disclosure
 *  is its body (what is written, what data moves, how to undo). */

export const PI_CREW_CONSENT_HEADLINE = 'Enable pi-messenger Crew';

export const PI_CREW_CONSENT_DISCLOSURE = `Pixel Agents will read your project's Crew activity feed (.pi/messenger/feed.jsonl)
to visualize your Crew agents (planner, workers, reviewer) as pixel-art characters
in the office.

Each Crew worker gets its own character that shows its current task and status.
Task progress, blocks, and completions are reflected in real time.

No data is sent anywhere. The feed is read locally from your project directory.

You can disable this at any time from the Settings panel.`;