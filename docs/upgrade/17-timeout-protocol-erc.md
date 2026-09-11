# Connectivity Intelligence Engine — Timeout + Protocol ERC Upgrade

## 1. Schematic extraction timeout

The synchronous schematic extractor previously had three conflicting limits:

- Vercel function max duration: 60s
- total schematic AI budget: 52s
- per-attempt abort cap: 50s

A normal model call close to 50s therefore failed before a useful retry could finish.

This upgrade changes the runtime to:

- Vercel `api/schematic-convert.js` maxDuration: 180s
- total extraction budget: 145s by default
- two adaptive attempts by default
- ~68s per-attempt cap
- optional `SCHEMATIC_FALLBACK_MODEL`
- compact Connectivity-first JSON by default
- default output budget reduced from 24576 to 12288 tokens
- 504 `schematic_extraction_timeout` with elapsed timing when all retries fail

The extractor still supports a full-detail mode through `SCHEMATIC_EXTRACTION_DETAIL=full`.

## 2. Protocol ERC layer

Connectivity analysis now has three deterministic zero-token layers:

1. Graph ERC
2. Protocol ERC
3. Power ERC

Protocol ERC covers:

- I2C: SDA/SCL grouping, pull-up/pull-down detection, unresolved bias rail, push-pull metadata review
- SPI: SCK/MOSI driver count, MISO shared-driver semantics, CS coverage
- UART: TX/TX and RX/RX mistakes, pair endpoint symmetry, multidrop review
- USB: D+/D- endpoint symmetry and USB-C CC1/CC2 presence
- SWD/JTAG: debug connector GND and VTREF/VREF checks; SWD NRST recommendation

Interface grouping ignores passive parts for bus identity and merges transitive SPI bus/CS groups. A shared SPI MISO bus is no longer automatically treated as a generic multi-driver short; it is handled by protocol rules instead.

All protocol checks are returned in Connectivity IR as:

- `interfaces[].protocolChecks`
- `interfaces[].protocolStatus`
- `protocolChecks`
- `protocolSummary`
- protocol issues in the shared `issues[]` list with `layer: "protocol"`
