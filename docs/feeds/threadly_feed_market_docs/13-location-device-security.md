# Location, Device, IP, and Security

## Location decision

For feed and market ranking, exact GPS is not required by default.

Use priority:

1. user-declared/manual location;
2. permission-based approximate or GPS location;
3. IP-derived rough country/city;
4. global fallback.

## Location usage

Location may influence:

* Loved Near You;
* cold-start regional ranking;
* local social proof labels;
* fraud/security review;
* shipping relevance later.

## User consent

Exact GPS must require explicit user permission. If denied, do not repeatedly prompt, but repromot where the user needs to interact with a feature that needs the permission. Use manual/global fallback.

## Mobile package

If using Expo, use:

```text
expo-location
```

Only request when needed.

## Web package

Use browser Geolocation API only with explicit user action/consent.

## IP handling

Recommended:

* store hashed IP for analytics/security grouping;
* store raw IP only if necessary and with limited retention;
* expose IP/location use in Privacy Policy;
* avoid selling/sharing data.

## Device/session tracking

Use normal authenticated session/device records, not invasive fingerprinting.

```text
UserDeviceSession
- id
- userId
- deviceLabel
- platform
- appVersion
- ipHash
- approximateLocation
- userAgentHash
- firstSeenAt
- lastSeenAt
- revokedAt
```

## Required screens

* Device \& Security.
* Active Sessions.
* Revoke Device.
* New Device Login Alert.
* Location Preferences.

## Security use cases

* alert on new device login;
* revoke stolen/lost device;
* identify unusual session location;
* support account recovery;
* avoid using device identity as hidden personalization without disclosure.

