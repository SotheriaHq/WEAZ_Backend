import { ContentIntegrityService } from './content-integrity.service';

describe('Approval message', () => {
  const message = (isPrivate?: boolean) =>
    (Object.create(ContentIntegrityService.prototype) as any).reviewOutcomeMessage(
      'approve',
      null,
      'Drimmer',
      null,
      "Ebi's Lines",
      isPrivate,
    );

  it('says a public design is live', () => {
    expect(message(false)).toContain('is now live');
  });

  it('never says a private design is live, and says what to do', () => {
    const text = message(true);
    expect(text).not.toContain('is now live');
    expect(text).toContain('set to Private');
    expect(text).toContain('choose Public');
  });
});
