# Security Policy

## Supported Versions

Use this section to tell people about which versions of your project are
currently being supported with security updates.

| Version | Supported          |
| ------- | ------------------ |
| 5.1.x   | :white_check_mark: |
| 5.0.x   | :x:                |
| 4.0.x   | :white_check_mark: |
| < 4.0   | :x:                |

## Reporting a Vulnerability

### Advisory Reference
Dependabot Alert #7
Package: jws (npm)
Affected Versions: < 3.2.3
Patched Version: 3.2.3

### Summary

An improper signature verification vulnerability exists in the `auth0/node-jws`
implementation when using the HS256 algorithm under specific conditions.

The vulnerability occurs when the `jws.createVerify()` function is used with
HMAC algorithms and user-controlled data from the JSON Web Signature (JWS)
Protected Header or Payload is used during HMAC secret lookup routines.
Under these circumstances, improper verification may occur.

Applications using the `jws.verify()` interface, including those using
`auth0/node-jsonwebtoken`, are not affected by this issue.

### Resolution

1. Upgrade `jws` to version **3.2.3 or later**.
2. Regenerate and commit updated lockfiles.
3. Review authentication and token verification logic to ensure safe handling
   of user-supplied data.
4. Confirm CI validation before closing the alert.

### Response Expectations

- Initial review within 3 business days.
- Patch deployment for supported versions within 7 business days.
- Responsible disclosure practices will be followed if public reporting is required.
