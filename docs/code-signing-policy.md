# Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

## What is signed

The Windows setup, `MineAI-Setup-<version>.exe`. It is built by `.github/workflows/release-windows.yml` from a
`pre-alpha-X.Y.Z` tag of this repository, on a GitHub-hosted runner. Each signing is approved by hand before the
certificate is used. Windows shows the publisher "SignPath Foundation".

## What is not signed by us

- `bun.exe` (Oven's Bun, MIT licence), shipped as its publisher signed it.
- The uninstaller `unins000.exe`, which is unsigned.

## Components

Everything shipped is MIT (this repository) or an upstream open-source binary (`bun.exe`).

The `.agent` submodule listed in `.gitmodules` is a private development folder (notes, tests, tooling). No build
fetches it, and no release contains it.

## Team roles

- Committers and reviewers: [bahumbert](https://github.com/bahumbert).
- Approvers: [bahumbert](https://github.com/bahumbert).

## Privacy

What the program sends over the network, and who chooses each contact, is in [privacy.md](privacy.md).
