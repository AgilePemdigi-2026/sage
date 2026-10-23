# language:id

@sprint1 @controlled @browser @issue_5
Fitur: Aksi menghubungkan akun GitHub dari halaman utama

  @US_GH_01 @SAGE_FR_GH_01 @SAGE_FR_GH_03 @SAGE_FR_GH_08 @SAGE_FR_GH_10
  Skenario: callback penolakan menampilkan pesan aman dan login dapat dicoba lagi
    Dengan saya berada pada halaman utama SAGE
    Ketika saya memilih tautan Hubungkan GitHub
    Maka form login tampil tanpa memulai permintaan otorisasi
    Ketika callback GitHub terkendali ditolak
    Maka UI menampilkan pesan penolakan yang aman dan menyediakan retry
