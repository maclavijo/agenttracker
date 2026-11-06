import type { ActorIdentity, TokenDirectory } from '../auth.js';
import { AuthConfigError } from '../auth.js';

/**
 * Resolves `WEB_UI_HUMAN_TOKEN` to the human identity the web UI writes as.
 *
 * Unset or blank means the UI is read-only and the comment proxy answers 503.
 * A token that is not configured, or that resolves to an agent, is a startup
 * error: the UI must never silently write as someone else. The messages never
 * include the token.
 */
export function resolveWebUiHumanActor(
  directory: TokenDirectory,
  token: string | undefined,
): ActorIdentity | null {
  if (token === undefined || token.trim() === '') {
    return null;
  }

  const identity = directory.get(token);

  if (identity === undefined) {
    throw new AuthConfigError('WEB_UI_HUMAN_TOKEN is not present in the configured tokens');
  }

  if (identity.actorType !== 'human') {
    throw new AuthConfigError('WEB_UI_HUMAN_TOKEN must resolve to a human actor');
  }

  return identity;
}
