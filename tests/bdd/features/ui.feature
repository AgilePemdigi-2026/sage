# language:id

@sprint1 @controlled @browser @issue_5
Fitur: Workspace melindungi session pengguna

  @US_GH_01 @SAGE_FR_GH_09
  Skenario: pengguna tanpa session diarahkan ke login
    Dengan browser tidak memiliki cookie sesi SAGE
    Ketika saya membuka halaman workspace
    Maka saya diarahkan ke login dengan pesan sesi yang aman
