# IZ2S Platform 0.16.0-rc.4

## What’s new in 0.16.0-rc.4

- **IZPSlauncher** joins IZlauncher as a native console shell. Choose it in the panel before the next session; it is discovered through the ordinary shell descriptor.
- Blue portrait-card menu, categories and search, a lime mouse in a hat, and a new IZ logo with the author signature.
- A single **Recent activity** feed replaces the two welcome panels. It shows completed installations, updates and removals with versions and local timestamps. Empty activity collapses to one row and does not leave a scrollable blank area.
- **Remove from console** is available on loaded app cards in the PC panel and through **Minus** in either console shell. The package stays on the PC for loading again. Operations run at a menu boundary, after an active app returns.
- Build instructions, release notes and a reusable release template are included with the source. File Exchange remains the only bundled application; streaming and YouTube are separate projects.

## Download and install

Download **iz2s-platform-0.16.0-rc.4-file-exchange.tar.gz** and its `.sha256` file from this release. The automatic Source code archives are snapshots, not the prepared installation package.

```sh
sha256sum -c iz2s-platform-0.16.0-rc.4-file-exchange.tar.gz.sha256
tar -xzf iz2s-platform-0.16.0-rc.4-file-exchange.tar.gz
cd iz2s-platform
./install.sh --check
./install.sh
```

The installer creates a new versioned directory and prints its location. Start that installed copy with `start.sh` or its application shortcut. Existing settings and module installations are not overwritten; follow the FAQ when migrating an earlier installation.

Debian/Ubuntu and Arch-based Linux are supported by the installer. Linux x64 software/build/install checks passed. ARM64 remains a declared target with incomplete hardware validation. Windows and macOS are unsupported. The new IZPSlauncher shell was checked with desktop Vulkan; a physical Switch check has not been performed for this release.

Includes IZlauncher, IZPSlauncher, the IZMYSH engine and File Exchange. pepsipu and kurumuz remain explicit separate downloads in the panel. BlitBun and VacooTube remain separate module projects.

## Build from source

```sh
git clone https://github.com/byizmysh/IZ2S-Platform.git
cd IZ2S-Platform
git checkout v0.16.0-rc.4
node shells/izpslauncher/build.cjs
node shells/izlauncher/server/build-app.cjs
node distribution/verify.cjs
node --test distribution/tests/*.test.cjs
# Package a clean committed source tree:
node distribution/build.cjs
```

Requires Node.js 22+, Python 3/Pillow, DejaVu Sans, glslangValidator, spirv-val and the Linux dependencies listed in the installation guide. Review and commit changed generated assets before creating an archive; the builder records the source commit and refuses a dirty tree.

Read [README](README.md), [FAQ](FAQ.md), [support details](SUPPORT.md) and [development/testing guide](distribution/README-development.md). Component licenses and existing notices are retained; see LICENSE, LICENSE-SCOPE.md and THIRD_PARTY.json.
