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
Dependabot Alert #5
Package: qs (npm)
Affected Versions: >= 6.7.0, <= 6.14.1
Patched Version: 6.14.2

### Summary

The `arrayLimit` option in qs does not enforce limits for comma-separated
values when `comma: true` is enabled. This allows a denial of service (DoS)
via memory exhaustion by creating very large arrays from a single query
parameter (e.g., `?param=,,,,,,,,`).

This occurs because the comma parsing logic performs `split(',')` before
the `arrayLimit` or `throwOnLimitExceeded` checks are evaluated, allowing
attackers to bypass intended array size restrictions.

This behavior only occurs when the `comma: true` option is explicitly enabled,
as it is not the default configuration.

### Resolution

1. Upgrade qs to version 6.14.2 or later.
2. Regenerate and commit updated lockfiles.
3. Confirm applications do not enable `comma: true` unnecessarily.
4. If `comma: true` is required, enforce strict request and parameter limits.
Dependabot Alert #10  
Package: minimatch (npm)  
Affected Versions: < 3.1.3  
Patched Version: 3.1.3  

### Summary

The `minimatch` package contains a Regular Expression Denial of Service (ReDoS)
vulnerability caused by unbounded recursive backtracking in the `matchOne()`
function when evaluating glob patterns containing multiple non-adjacent
`**` (GLOBSTAR) segments.

When a crafted pattern with many globstar segments is evaluated against a
non-matching path, the function explores a combinatorial number of recursive
calls. This leads to exponential runtime complexity and can stall the Node.js
event loop for several seconds per invocation.

### Resolution

1. Upgrade `minimatch` to version **3.1.3 or later**.
2. Regenerate and commit updated dependency lockfiles.
3. Avoid evaluating attacker-controlled glob patterns.
4. Implement validation or restrictions on glob patterns accepted from user input.
5. Confirm CI validation before closing the alert.

### Response Expectations

- Initial review within 3 business days.
- Patch deployment for supported versions within 7 business days.
- Responsible disclosure practices will be followed if public reporting is required.
