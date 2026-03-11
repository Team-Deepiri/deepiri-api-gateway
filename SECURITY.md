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
Dependabot Alert #8
Package: axios (npm)
Affected Versions: >= 1.0.0, <= 1.13.4
Patched Version: 1.13.5

### Summary

A denial of service (DoS) vulnerability exists in the `mergeConfig`
function of the axios package. When configuration objects contain
`__proto__` as an own property, axios may throw a `TypeError` during
configuration merging.

An attacker can trigger this by supplying a malicious configuration
object generated through `JSON.parse()`. When axios processes this
object, prototype lookup causes an invalid function reference which
results in the application crashing.

### Resolution

1. Upgrade `axios` to version **1.13.5 or later**.
2. Regenerate and commit updated lockfiles.
3. Ensure applications do not pass user-controlled JSON objects directly
   into axios configuration methods.
4. Validate configuration objects before making outbound HTTP requests.
5. Confirm CI validation before closing the alert.

### Response Expectations

- Initial review within 3 business days.
- Patch deployment for supported versions within 7 business days.
- Responsible disclosure practices will be followed if public reporting is required.
