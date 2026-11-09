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

  it('says a public design is approved and published on the Runway', () => {
    expect(message(false)).toContain('“Drimmer” has been approved and published on the Runway');
  });

  it('never says a private design is published, and says what to do', () => {
    const text = message(true);
    expect(text).not.toContain('published');
    expect(text).toContain('set to Private');
    expect(text).toContain('make it Public');
  });
});
