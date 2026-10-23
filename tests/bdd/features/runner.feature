# language: id
Fitur: Persistensi runner tahap analysis Sprint 1
  Handler pada skenario ini adalah stub tepercaya khusus BDD untuk memeriksa kontrak runner.
  Status sembilan tahap selesai tidak berarti consumer repository, hasil graph, atau dokumen produk telah diterima.

  @sprint1 @US_TrackAnalysisProgress @SAGE_FR_REP_12 @SAGE_FR_ANA_11 @issue_35 @database @controlled
  Skenario: Runner mempersistenkan sembilan tahap secara berurutan
    Dengan database PostgreSQL disposable, dua pemilik, dan satu repository uji tersedia
    Ketika runner mengeksekusi sembilan handler uji berurutan untuk analysis pemilik pertama
    Maka sembilan status tahap selesai sesuai urutan kontrak dan tidak menerbitkan hasil produk terminal

  @sprint1 @US_TrackAnalysisProgress @SAGE_FR_REP_12 @SAGE_FR_ANA_11 @SAGE_FR_ANA_13 @issue_35 @database @controlled
  Skenario: Kegagalan handler menghentikan tahap downstream
    Dengan database PostgreSQL disposable, dua pemilik, dan satu repository uji tersedia
    Ketika handler STATIC_ANALYSIS melempar error internal saat runner menjalankan claim
    Maka runner gagal pada tahap tersebut, kode error aman disimpan, dan tahap downstream tetap pending

  @sprint1 @US_QueueLeaseSafety @SAGE_FR_REP_12 @SAGE_FR_ANA_11 @issue_35 @database @controlled
  Skenario: Runner tidak menjalankan handler setelah lease claim kedaluwarsa
    Dengan database PostgreSQL disposable, dua pemilik, dan satu repository uji tersedia
    Ketika lease claim pemilik pertama kedaluwarsa sebelum runner memulai tahap
    Maka runner usang tidak memanggil handler, recovery memindahkan claim, dan token lama tidak dapat menyentuh slot
