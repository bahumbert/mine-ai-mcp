# Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

## What is signed

The Windows setup, `MineAI-Setup-<version>.exe`. It is built by `.github/workflows/release-windows.yml` from a
`pre-alpha-X.Y.Z` tag of this repository, on a GitHub-hosted runner. Each signing is approved by hand before the
certificate is used. Windows shows the publisher "SignPath Foundation". The setup is signed once the SignPath Foundation
project is accepted; until then the setup is unsigned and its release notes say so.

## What is not signed by us

- `bun.exe` (Oven's Bun, MIT licence), shipped as its publisher signed it.
- The uninstaller `unins000.exe`, which is unsigned.

## Components

Everything shipped is this repository (MIT), the open-source npm packages bundled into the app, `minecraft-data` (MIT,
copied into the app as files), and `bun.exe` (Oven's Bun, MIT). The 136 bundled npm packages: 122 MIT, 6 ISC, 4
BSD-3-Clause, 1 BSD-2-Clause, 2 Apache-2.0, and 1 BSD (`vec3`, which gives no version).

The `.agent` submodule listed in `.gitmodules` is a private development folder (notes, tests, tooling). No build
fetches it, and no release contains it.

## Team roles

- Committers and reviewers: [bahumbert](https://github.com/bahumbert).
- Approvers: [bahumbert](https://github.com/bahumbert).

## Privacy

What the program sends over the network, and who chooses each contact, is in [privacy.md](privacy.md).
