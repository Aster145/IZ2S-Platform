# Platform support

| Host | Status for this candidate |
| --- | --- |
| Linux x64 | Implemented; local installation/software checks recorded in the validation notes |
| Linux ARM64 | Declared target; complete physical ARM64 console/media testing is still required |
| Windows x64 | Adapted in this fork: panel, IZMYSH, ESP32-S3 TextKeyboard and File Exchange. IZlauncher, directory browsing and FTP download were tested on Switch 2 23.0.1 / SmileBASIC 4.4.9. IZPSlauncher has host resource-generation checks only. Optional ARM input is retained. See [Windows validation](WINDOWS-README.md#本次验证范围). |
| macOS | Unsupported in this release |

The web panel and some JavaScript/Electron components may run on other operating
systems. That alone does not establish support for the complete Switch workflow.
Building a desktop Electron app is separate from implementing console streaming.
WSL, Wine and containers are not qualified Windows configurations.

The Windows port covers the base platform; optional streaming modules and their
capture/audio integrations are not included. ARM input-agent setup and host ARM64 support are separate:
a working ARM USB keyboard board does not qualify ARM64 media playback.

This document describes the current implementation, not an upstream library's
potential platform list. See each package's README for dependencies and actual
validation limits. No new hardware qualification is implied by packaging.
