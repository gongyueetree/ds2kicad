# Connectivity Intelligence Engine

## Product direction

Connectivity is the source of truth for circuit design. A traditional schematic is a human-readable renderer of the connectivity graph, not the authoritative design model.

The engine therefore treats the flow as:

```text
PDF / image / EDA source
        ↓
component + pin + connectivity extraction
        ↓
Connectivity IR
        ├─ deterministic Graph ERC (0 model tokens)
        ├─ Net-centric Connection Map
        ├─ Component-centric Pin → Net → peer view
        ├─ Interface detection (I2C/SPI/UART/USB/SWD/JTAG)
        ├─ Power Rail view
        ├─ future semantic ERC / Component Rules
        ├─ future PCB placement/routing
        └─ KiCad schematic renderer / MCP exporter
```

## Connectivity IR

Schema version: `connectivity-intelligence.ir.v1`.

Core authoritative entities:
- Components
- Pins
- Nets (hyperedges with N endpoints)
- No-connect declarations

Derived deterministic entities:
- Issues / ERC
- Interfaces
- Power Rails
- Connectivity health

Derived data can always be regenerated from the authoritative graph after a user edit.

## Human review UX

The Connectivity Engine exposes five views:
1. Connection Map — select a net and inspect every endpoint.
2. Components — inspect every Pin → Net → peer relationship.
3. Interfaces — protocol-level grouping and completeness checks.
4. ERC / Issues — deterministic Error / Warning / Review findings.
5. Traditional Schematic — optional KiCad-compatible rendering for engineers who still prefer schematic review.

## Cost model

Graph ERC, interface recognition, power analysis and human views do not use an LLM. Model use is limited to extracting ambiguous information from source PDFs/images. Datasheet processing should continue to prefer deterministic PDF/table/OCR extraction and use inexpensive models only for unresolved fields.

## Test-stage credits

Credit enforcement is disabled by default during product testing:

```env
CREDIT_ENFORCEMENT=0
TEST_CREDIT_BALANCE=100000
```

This preserves all metering and billing code without blocking tests or deducting quota.

When the service is opened publicly, enable normal quota enforcement without a code change:

```env
CREDIT_ENFORCEMENT=1
GUEST_FREE_CREDITS=3
REGISTERED_FREE_CREDITS=5
COST_DATASHEET_TO_KICAD=1
COST_SCHEMATIC_TO_KICAD=5
```

The existing Reserve → Commit / Refund ledger remains the production billing path and is covered by tests with enforcement explicitly enabled.

## Repository compatibility

The GitHub repository and Vercel project remain named `ds2kicad` for deployment continuity. The user-visible product name is **Connectivity Intelligence Engine**.
