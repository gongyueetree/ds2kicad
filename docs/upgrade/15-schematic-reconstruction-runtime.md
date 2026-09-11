# Schematic Reconstruction Runtime

This module adds the missing **PDF/image schematic → editable KiCad schematic** workflow to DS2KiCad.

## Entry points

- Existing library workflow: `/?mode=library`
- Schematic reconstruction: `/?mode=schematic`
- Chinese EETree example: `/?mode=schematic&channel=eetree&lang=zh-CN`
- English Tindie example: `/?mode=schematic&channel=tindie&lang=en-US`

The sticky Agent bar exposes both modes, so embedded EETree/Tindie users do not need to know the query parameter.

## Runtime pipeline

```text
PDF / PNG / JPG
      ↓
image → single-page PDF wrapper (browser, images only)
      ↓
/api/schematic-convert
      ↓
Vision model: components + pins + connectivity candidate
      ↓
Schematic IR sanitizer
      ↓
Confidence / endpoint validation
      ↓
Deterministic KiCad compiler
      ↓
reconstructed.kicad_sch
reconstructed.sch
reconstructed-cache.lib
schematic-ir.json
conversion-report.json
```

The model never writes KiCad S-expressions directly. This is intentional: model output is treated as uncertain evidence and is first normalized into `ds2kicad.schematic-ir.v1`.

## Connectivity strategy

The extraction prompt explicitly distinguishes:

- crossing wires **without** a junction dot → not connected;
- crossing wires **with** a junction dot → connected;
- identical net labels → same electrical net;
- every endpoint must resolve to a real `(reference, pin-number)` pair.

The compiler does not ask the model to redraw arbitrary wire paths. It regenerates the symbol layout and places same-name local labels directly on the resolved pin anchors. This preserves the logical net graph while reducing accidental shorts caused by hallucinated routing.

## KiCad output

The primary output is a modern `.kicad_sch` with:

- embedded `lib_symbols` definitions;
- symbol instances with UUIDs;
- per-pin UUID mappings;
- project/path/reference/unit instance data;
- local labels on regenerated pin anchors;
- no-connect markers;
- root sheet instance metadata.

A legacy `.sch` + `reconstructed-cache.lib` pair is generated as a compatibility fallback.

## Review UI

After conversion, users can review:

- component reference;
- value / part number;
- symbol library ID;
- footprint;
- pin number;
- pin name;
- electrical type;
- pin side;
- component/pin/net confidence;
- reconstructed net endpoints and extraction evidence.

Changing a component reference or pin number also rewrites matching Net endpoints and No-Connect markers atomically. Clicking **Rebuild after edits** invokes `/api/schematic-build`; it is deterministic and consumes no additional AI Credit.

## Trial / Credit

- Registered/default schematic cost: `COST_SCHEMATIC_TO_KICAD` (default 5).
- Guest trial schematic cost: `GUEST_SCHEMATIC_TRIAL_COST` (default 3).
- Guest wallet default: `GUEST_FREE_CREDITS=3`, therefore a new guest can perform one complete schematic conversion trial.
- Failed model/download/conversion runs are refunded through the existing Reserve → Commit / Refund ledger.

## Environment

```text
GEMINI_API_KEY=
SCHEMATIC_MODEL=
SCHEMATIC_EXTRACT_BUDGET_MS=52000
SCHEMATIC_MAX_OUTPUT_TOKENS=24576
GUEST_SCHEMATIC_TRIAL_COST=3
```

If `SCHEMATIC_MODEL` is empty, the runtime reuses `GEMINI_MODEL`.

## Current P0/P1 boundaries

The current runtime is deliberately conservative:

1. It reconstructs the first actual schematic sheet from a multi-page PDF; full hierarchy is a follow-up.
2. It prioritizes logical connectivity over pixel-identical wire geometry.
3. Common passives/connectors get KiCad official-library ID hints. Exact ezPLM/KiCad library retrieval for arbitrary ICs should be added as the next Symbol Resolver stage.
4. Unknown ICs are represented by deterministic generated rectangular symbols using extracted pin definitions.
5. Footprints are retained only when the source/recognition provides evidence; the schematic converter does not invent packages.
6. Low-confidence pin mappings and ambiguous nets are surfaced as warnings and must be reviewed before production use.
7. Bus/hierarchical-sheet semantics are not yet reconstructed as native KiCad bus/sheet objects.

## Validation

The schematic tests cover:

- common library-ID resolution;
- net endpoint normalization;
- modern `.kicad_sch` generation;
- per-pin UUID mappings;
- symbol instance project/path/reference metadata;
- root sheet metadata;
- modern + legacy bundle output;
- strict junction/crossing semantics in the extraction prompt.

Use:

```bash
npm test
npm run build
```

Vercel deploys `api/schematic-convert.js` with a 60-second function budget and `api/schematic-build.js` with a 30-second budget.
