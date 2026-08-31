import {
  feedAudienceFromProfileGender,
  needsGenderPrompt,
  parseProfileGender,
  PROFILE_GENDER_OPTIONS,
  profileGenderLabel,
  sizingBodyFromProfileGender,
} from './profile-gender';

describe('profile-gender', () => {
  it('parses the four stored answers and common aliases', () => {
    expect(parseProfileGender('MALE')).toBe('MALE');
    expect(parseProfileGender('female')).toBe('FEMALE');
    expect(parseProfileGender('non-binary')).toBe('NON_BINARY');
    expect(parseProfileGender('prefer_not_to_say')).toBe('UNSPECIFIED');
    expect(parseProfileGender('nope')).toBeNull();
    expect(parseProfileGender(null)).toBeNull();
  });

  it('maps identity onto the body the size engine designates against', () => {
    expect(sizingBodyFromProfileGender('MALE')).toBe('MEN');
    expect(sizingBodyFromProfileGender('FEMALE')).toBe('WOMEN');
    expect(sizingBodyFromProfileGender('NON_BINARY')).toBe('UNISEX');
    expect(sizingBodyFromProfileGender('UNSPECIFIED')).toBe('UNISEX');
    expect(sizingBodyFromProfileGender(null)).toBe('UNISEX');
  });

  it('never silently defaults the feed to one audience', () => {
    expect(feedAudienceFromProfileGender('MALE')).toEqual(['MALE', 'EVERYBODY']);
    expect(feedAudienceFromProfileGender('FEMALE')).toEqual([
      'FEMALE',
      'EVERYBODY',
    ]);
    expect(feedAudienceFromProfileGender(null)).toEqual([
      'MALE',
      'FEMALE',
      'EVERYBODY',
    ]);
    expect(feedAudienceFromProfileGender('UNSPECIFIED')).toEqual([
      'MALE',
      'FEMALE',
      'EVERYBODY',
    ]);
  });

  it('treats never-asked as a prompt and "rather not say" as an answer', () => {
    expect(needsGenderPrompt(null)).toBe(true);
    expect(needsGenderPrompt(undefined)).toBe(true);
    expect(needsGenderPrompt('UNSPECIFIED')).toBe(false);
    expect(needsGenderPrompt('MALE')).toBe(false);
  });

  it('shows Man / Woman to shoppers, never Men / Women or the stored codes', () => {
    expect(profileGenderLabel('MALE')).toBe('Man');
    expect(profileGenderLabel('FEMALE')).toBe('Woman');
    expect(profileGenderLabel('NON_BINARY')).toBe('Non-binary');
    expect(profileGenderLabel('UNSPECIFIED')).toBe("I'd rather not say");
    expect(PROFILE_GENDER_OPTIONS.map((option) => option.label)).toEqual([
      'Man',
      'Woman',
      'Non-binary',
      "I'd rather not say",
    ]);
    expect(PROFILE_GENDER_OPTIONS.map((option) => option.label).join(' ')).not.toMatch(
      /\b(Men|Women|Male|Female)\b/,
    );
  });
});
