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
