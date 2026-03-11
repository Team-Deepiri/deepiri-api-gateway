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
5. Confirm CI validation before closing the alert.

### Response Expectations

- Initial review within 3 business days.
- Patch deployment for supported versions within 7 business days.
- Responsible disclosure practices will be followed if public reporting is required.
