# Deterministic Component Skeleton + Batched Connectivity Extraction

The component census is now an actual input to Connectivity IR, not only a quality checklist.

For vector/text-layer PDFs:

1. Extract all visible reference designators deterministically from the PDF text layer.
2. Build a component skeleton (ref, approximate position, nearby value/MPN hint, generic passive pins where safe).
3. Split the reference list into small focus batches.
4. Ask the model only to trace pins/nets touching each focus batch; it no longer owns component discovery.
5. Merge batch results into the deterministic skeleton.
6. Run source-grounded quality gate + ERC.

This specifically fixes the failure where Multimeter Click returned only a few capacitors even though its PDF text layer exposes ~80 reference designators.
