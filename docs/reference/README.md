# Reference

- [Arsitektur](ARCHITECTURE.md) — web, worker, database, pipeline, dan storage.
- [Kontrak analyzer](ANALYSIS_SPEC.md) — fakta teknis, resolver, evidence, dan batas dukungan.
- [TOGAF Phase C ADD](TOGAF_ADD.md) — baseline output, ArchiMate view, catalog/matrix, koreksi, LLM, dan batas interpretasi.
- [Peta implementasi dan acceptance ADD](../planning/TOGAF_ADD_TRACEABILITY.md) — tautan requirement ke implementasi, pengujian, hasil benchmark, dan batas yang masih terbuka.
- [Model semantik](SEMANTIC_ANALYSIS.md) — fitur/alur, confidence, koreksi, dan snapshot ekspor.
- [Explainable analysis](EXPLAINABLE_ANALYSIS.md) — proyeksi source-backed dan batas interpretasi.
- [Model data](DATA_MODEL.md) — entitas, isolasi pemilik, retensi, dan lifecycle.
- [Kontrak API](API_CONTRACT.md) — endpoint tersedia serta rancangan yang diberi label eksplisit.
- [Format keluaran](DOCUMENT_PRESENTATION.md) dan [keterbacaan diagram](DIAGRAM_READABILITY.md).
- [Design guidelines](DESIGN_GUIDELINES.md) dan [bahasa UI](UI_LANGUAGE.md).

TOGAF ADD merupakan keluaran utama analisis arsitektur. Code Knowledge adalah visualisasi pendamping untuk menelusuri struktur/dependency source; itu bukan Software Engineering Diagram dan tidak menggantikan ADD. Evidence mengikat temuan ke snapshot commit, file, dan baris; bukti pemeriksaan terdahulu tersimpan pada [lokasi tetap](../evidence/). `Exact`/`Unresolved` berbeda dari `Proven`/`Indicated`. Tidak semua source menghasilkan flow atau architecture fact.

[Beranda dokumentasi](../README.md)
