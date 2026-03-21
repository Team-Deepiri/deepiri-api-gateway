# Git Hooks Directory

This directory contains Git hooks that protect the `main` and `master` branches.

## Protected Branches

- **main** - Production branch (exact match)
- **master** - Legacy production branch (exact match, protected for compatibility)

## Automatic Setup

**Git hooks are automatically configured when you clone the repository!**

The `core.hooksPath` is set to `.git-hooks` automatically, so you don't need to run any setup scripts.

## Manual Setup (If Needed)

If hooks aren't working (e.g., for existing clones before automatic setup was added), run:

```bash
./setup-hooks.sh
```

Or manually:
```bash
git config core.hooksPath .git-hooks
```

## Hooks

- **pre-push**: Blocks direct pushes to protected branches:
  - Exact matches: `main`, `master`
  - Allowed: `dev`, `name-dev`, `dev-something`, `my-dev-branch`
- **post-checkout**: Automatically configures hooksPath on checkout (if not already set)
- **post-merge**: Automatically syncs hooks to submodules on pull
suffix)
```

This confirms hooks are working!
