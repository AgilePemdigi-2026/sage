# Reference

- [Arsitektur](ARCHITECTURE.md) — web, worker, database, pipeline, dan storage.
- [Kontrak analyzer](ANALYSIS_SPEC.md) — fakta teknis, resolver, evidence, dan batas dukungan.
- [Model semantik](SEMANTIC_ANALYSIS.md) — fitur/alur, confidence, koreksi, dan snapshot ekspor.
- [Explainable analysis](EXPLAINABLE_ANALYSIS.md) — proyeksi source-backed dan batas interpretasi.
- [Model data](DATA_MODEL.md) — entitas, isolasi pemilik, retensi, dan lifecycle.
- [Kontrak API](API_CONTRACT.md) — endpoint tersedia serta rancangan yang diberi label eksplisit.
- [Format keluaran](DOCUMENT_PRESENTATION.md) dan [keterbacaan diagram](DIAGRAM_READABILITY.md).
- [Design guidelines](DESIGN_GUIDELINES.md) dan [bahasa UI](UI_LANGUAGE.md).

Evidence mengikat temuan ke snapshot commit, file, dan baris; kumpulan evidence pengujian tersimpan pada [lokasi tetap](../evidence/). Fakta `Exact`/`Unresolved` berbeda dari confidence semantik `Proven`/`Indicated`. Tidak semua source menghasilkan user flow.

[Beranda dokumentasi](../README.md)
