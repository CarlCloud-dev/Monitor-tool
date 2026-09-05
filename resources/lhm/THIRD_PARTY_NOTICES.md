# Libre Hardware Monitor notices

This directory contains the Libre Hardware Monitor 0.9.7-pre731 runtime files, obtained from the official NuGet pre-release package:

- Source: https://github.com/LibreHardwareMonitor/LibreHardwareMonitor
- Package: https://www.nuget.org/packages/LibreHardwareMonitorLib/0.9.7-pre731
- Source commit: 8cbda900bb52a6a8f0cfe39d41aa4d48938e5554
- License: Mozilla Public License 2.0 (MPL-2.0)

The aligned runtime dependencies were obtained from their official NuGet packages:

- DiskInfoToolkit 2.1.4 — https://www.nuget.org/packages/DiskInfoToolkit/2.1.4 — MPL-2.0
- BlackSharp.Core 1.2.0 — https://www.nuget.org/packages/BlackSharp.Core/1.2.0 — MPL-2.0
- RAMSPDToolkit-NDD 1.6.1 — https://www.nuget.org/packages/RAMSPDToolkit-NDD/1.6.1 — MPL-2.0

`MonitorLhmBridge.exe` is this project's small local helper. It opens Libre Hardware Monitor only when the user enables enhanced sensors, sends JSON through its standard output to the parent app, and does not listen on a network port or transmit telemetry.

Libre Hardware Monitor bundles additional third-party dependencies. Preserve this notice and the original package notices when packaging or redistributing this application.

`PawnIO_setup.exe` 2.1.0 is bundled for the optional, user-triggered hardware access setup. It was extracted unchanged from Libre Hardware Monitor's official source resource, has SHA-256 `A3A46226C5E2824F4CDD42BE0EECBABFC672C86F7889710F5AB1E6AD385B47A0`, and was verified as Authenticode-signed by `namazso.eu`. The application verifies this hash before launching it with UAC and never performs a silent installation. See https://pawnio.eu/ and https://github.com/namazso/PawnIO for the driver and its license terms.
