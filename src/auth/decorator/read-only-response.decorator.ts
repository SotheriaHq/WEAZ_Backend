import { SetMetadata } from '@nestjs/common';

export const READ_ONLY_RESPONSE_KEY = 'wiez.readOnlyResponse';

/** Explicitly opt a non-mutating POST lookup into read-response authorization.
 * Never apply to commands: completion must not consume a mutation proof twice. */
export const ReadOnlyResponse = () => SetMetadata(READ_ONLY_RESPONSE_KEY, true);
