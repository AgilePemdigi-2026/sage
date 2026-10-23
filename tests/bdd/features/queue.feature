# language: id
Fitur: Antrean analisis global dan kepemilikan
  Skenario PostgreSQL ini memakai pemilik dan repository disposable pada satu database Sprint 1 yang terisolasi.

  @sprint1 @US_QueueAnalysis @SAGE_FR_REP_11 @issue_9 @database @controlled
  Skenario: Dua pemilik mengantre pada satu slot global
    Dengan database PostgreSQL disposable, dua pemilik, dan satu repository uji tersedia
    Ketika pemilik pertama mengantrekan commit "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    Dan pemilik kedua mengantrekan commit "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    Maka hanya satu claim global aktif, FIFO memberi pemilik pertama giliran, dan owner lain tidak dapat membaca analisisnya

  @sprint1 @US_IdempotentAnalysisSubmission @SAGE_FR_REP_11 @issue_8 @database @controlled
  Skenario: Replay idempotency mempertahankan target dan tetap dibatasi ke pemilik
    Dengan database PostgreSQL disposable, dua pemilik, dan satu repository uji tersedia
    Ketika pemilik pertama mengantrekan key "stable-request" payload "repo/main/no-explicit-commit" dan commit "cccccccccccccccccccccccccccccccccccccccc"
    Dan pemilik pertama mengantrekan key "stable-request" payload "repo/main/no-explicit-commit" dan commit "dddddddddddddddddddddddddddddddddddddddd"
    Dan pemilik kedua mengirim key "stable-request" payload "repo/main/no-explicit-commit" dan commit "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    Maka replay pemilik pertama mempertahankan full SHA awal sedangkan key yang sama membuat analysis terpisah untuk pemilik kedua

  @sprint1 @US_QueueLeaseSafety @SAGE_FR_REP_11 @issue_9 @database @controlled
  Skenario: Token lease lama tidak dapat melepaskan pekerjaan pemilik lain
    Dengan database PostgreSQL disposable, dua pemilik, dan satu repository uji tersedia
    Ketika dua pemilik mengantre lalu claim pertama kedaluwarsa dan worker baru mengklaim antrean
    Maka token lease lama tidak dapat memperbarui atau menggagalkan job baru yang sedang berjalan
