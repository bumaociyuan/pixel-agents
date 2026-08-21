/** Consent disclosure for the pi agent provider. */

export const PI_AGENT_CONSENT_HEADLINE = 'Detect Pi agents via herdr';

export const PI_AGENT_CONSENT_DISCLOSURE =
  'Pixel Agents will poll the herdr API to discover running Pi agent panes. ' +
  'Each pi agent found in the current project will appear as a pixel-art character. ' +
  'The watcher reads agent status (working / idle / blocked) and the current task label — ' +
  'it never reads terminal output content. No data leaves your machine. ' +
  'You can disable this at any time in the Settings modal.';
