# language:id

@sprint1 @controlled @browser @issue_7 @issue_66
Fitur: Pemilihan repository dan validasi target di browser

  @US_REP_01 @SAGE_FR_REP_01 @SAGE_FR_REP_02 @SAGE_FR_REP_13 @SAGE_FR_GH_05 @SAGE_FR_GH_06
  Skenario: daftar public dan private terotorisasi dapat dicari
    Dengan API repository dikendalikan untuk skenario browser
    Ketika saya membuka repository sebagai akun sintetis "utama"
    Maka saya melihat repository public milik akun dan repository private berizin
    Ketika saya mencari repository yang tidak ada dalam halaman yang dimuat
    Maka hasil pencarian kosong tanpa menghapus daftar repository tersimpan
    Maka UI tidak mengalami error JavaScript atau request API di luar skenario

  @US_REP_02 @SAGE_FR_REP_05 @SAGE_FR_REP_06 @SAGE_FR_REP_07 @SAGE_FR_REP_08 @SAGE_FR_REP_09
  Skenario: branch terpilih memakai full SHA saat commit kosong atau ditentukan
    Dengan API repository dikendalikan untuk skenario browser
    Ketika saya membuka repository sebagai akun sintetis "utama"
    Dan saya memilih repository public akun pada branch "feature/sprint-one"
    Ketika saya memeriksa target dengan commit kosong
    Maka target kosong memakai full SHA branch
    Ketika saya memeriksa target dengan full SHA tersebut
    Maka request validasi menyertakan full SHA yang dipilih
    Dan UI tidak mengalami error JavaScript atau request API di luar skenario

  @US_REP_02 @SAGE_FR_REP_05 @SAGE_FR_REP_09
  Skenario: error branch dan validasi target dapat dicoba ulang
    Dengan API repository dikendalikan untuk skenario browser
    Dan API branch gagal pada permintaan pertama
    Dan API validasi target gagal pada permintaan pertama
    Ketika saya membuka repository sebagai akun sintetis "utama"
    Dan saya memilih repository public akun
    Maka UI menampilkan error branch terkendali dengan opsi retry
    Ketika saya mencoba ulang pemuatan branch
    Dan saya mengirim validasi target
    Maka UI menampilkan error target terkendali tanpa kehilangan pilihan
    Ketika saya mengulangi validasi target
    Maka target berhasil tervalidasi setelah retry
    Dan UI tidak mengalami error JavaScript atau request API di luar skenario

  @US_REP_01 @SAGE_FR_REP_01 @SAGE_FR_GH_05
  Skenario: kegagalan daftar repository public dapat dicoba ulang
    Dengan API repository dikendalikan untuk skenario browser
    Dan API daftar repository public gagal pada permintaan pertama
    Ketika saya membuka repository sebagai akun sintetis "utama"
    Maka daftar repository public menampilkan error dan tindakan retry
    Ketika saya mencoba ulang daftar repository public
    Maka daftar repository public pulih setelah retry
    Dan UI tidak mengalami error JavaScript atau request API di luar skenario

  @US_REP_02 @SAGE_FR_REP_05 @SAGE_FR_REP_09
  Skenario: repository tanpa branch menahan validasi sampai branch dimuat ulang
    Dengan API repository dikendalikan untuk skenario browser
    Dan API branch mengembalikan daftar kosong pada permintaan pertama
    Ketika saya membuka repository sebagai akun sintetis "utama"
    Dan saya memilih repository public akun
    Maka branch kosong mencegah pemeriksaan target dan dapat dimuat ulang
    Dan UI tidak mengalami error JavaScript atau request API di luar skenario

  @US_REP_01 @SAGE_FR_GH_05 @SAGE_FR_REP_01
  Skenario: pergantian session membersihkan daftar milik akun sebelumnya
    Dengan API repository dikendalikan untuk skenario browser
    Ketika saya membuka repository sebagai akun sintetis "utama"
    Maka saya melihat repository public milik akun dan repository private berizin
    Ketika session browser berganti ke akun sintetis "kedua"
    Maka repository yang terlihat hanya berasal dari akun baru
    Dan UI tidak mengalami error JavaScript atau request API di luar skenario
