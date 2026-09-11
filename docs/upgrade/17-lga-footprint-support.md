# LGA footprint generation

Connectivity Intelligence Engine previously extracted LGA package evidence but intentionally refused to generate a footprint because the deterministic package engine only allowed `dual`, `qfn`, `dip`, and `sot23` families.

This upgrade adds a first deterministic LGA perimeter-pad generator. It is intended for packages such as KXTJ3-1057 12-LGA 2x2 mm.

Rules:
- LGA is recognized explicitly; it is never routed through the dual/QFN fallback.
- Pin count must be divisible by four for the perimeter-pad generator.
- Required geometry: pinCount, pitch, bodyLength, bodyWidth, leadLength (terminal length), leadWidth (terminal width), height.
- If a datasheet recommended land pattern exists, its pad dimensions are preferred.
- If only package terminal geometry exists, footprint generation is allowed as a provisional derived-by-rules footprint; it remains non-authoritative and should be reviewed.
- Pin 1 begins at the upper-left edge; numbering proceeds counter-clockwise around the four sides, matching the existing QFN perimeter convention.
- 3D is approximate/parametric, not a vendor STEP model.

The viewer now surfaces generator warnings/reasons when a footprint is blocked instead of showing only a generic empty state.

Verification includes a KXTJ3-style 12-LGA fixture that asserts 12 KiCad pads, a generated `.kicad_mod`, an approximate WRL model, and fail-closed behavior when terminal geometry is missing.
