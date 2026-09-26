# DETOX standalone Archive

Everything needed to rebuild the DETOX-P2 Archive (CONTEXT.md: Archive,
Ingest Config; docs/adr/0054, 0056). Nothing else is required -- not the main
Geode Archive, not conda:

```bash
python prep/assemble_archive.py --out archive-detox --from-release data-v22 \
    --copy colormaps.json coastlines boundaries surface \
    --model archives/detox/detox-p2.ingest.json
```

`detox-p2.ingest.json` records every judgement call and the evidence for it;
the assembled Archive carries a copy of it beside the Model, plus the
Model's Verification Card under `models/detox-p2/verification/`.
