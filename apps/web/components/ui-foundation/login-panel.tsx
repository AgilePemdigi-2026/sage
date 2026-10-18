"use client";
import { useEffect, useRef } from "react";
import { Badge, Icon, Loading, Notice } from "./primitives";
import type { LoginState } from "./types";
import styles from "./ui-foundation.module.css";
export interface LoginPanelProps { state: LoginState; onConnect: () => void; onContinue: () => void; userLabel?: string }
export function LoginPanel({ state, onConnect, onContinue, userLabel = "Pengguna" }: LoginPanelProps) {
  const continueButton = useRef<HTMLButtonElement>(null); const connectRequested = useRef(false);
  useEffect(() => { if (connectRequested.current && state === "connected") { connectRequested.current = false; continueButton.current?.focus(); } }, [state]);
  return <div className={styles.loginGrid}>
    <section className={styles.introduction} aria-label="Tentang SAGE">
      <Badge>PEMAHAMAN DIMULAI DARI KODE</Badge>
      <h2 className={styles.hero}>Pahami strukturnya.<br /><span>Telusuri buktinya.</span></h2>
      <p className={styles.lead}>Dari repository ke graph dan dokumentasi arsitektur, dengan setiap temuan terhubung ke source code.</p>
      <ul className={styles.featureList}>
        <li><Icon name="repository" /><div><strong>Satu konteks yang konsisten</strong><p>Repository, branch, dan commit tetap dapat ditelusuri.</p></div></li>
        <li><Icon name="code" /><div><strong>Bukti di balik setiap hubungan</strong><p>Periksa file dan lokasi kode yang mendasari analisis.</p></div></li>
        <li><Icon name="progress" /><div><strong>Alur yang dapat diikuti</strong><p>Pantau tahap pemrosesan dan keterbatasan hasil.</p></div></li>
      </ul>
    </section>
    <section className={styles.card} aria-labelledby="login-heading">
      <div className={styles.iconTile}><Icon name="github" /></div>
      <h2 id="login-heading">Hubungkan GitHub</h2><p className={styles.muted}>Login diperlukan untuk menghubungkan akses repository dan riwayat analisis ke akun Anda.</p>
      {state === "loading" && <Loading label="Menghubungkan ke GitHub…" />}
      {state === "denied" && <Notice tone="warning" title="Izin GitHub belum diberikan">Anda dapat mencoba lagi dan meninjau izin yang diminta.</Notice>}
      {state === "error" && <Notice tone="error" title="Koneksi GitHub gagal">Koneksi belum berhasil dibuat. Coba hubungkan kembali.</Notice>}
      {state === "connected" ? <><Notice tone="success" title="Contoh koneksi berhasil">Akun contoh: {userLabel}. Ini bukan sesi GitHub yang sesungguhnya.</Notice><button ref={continueButton} className={styles.primaryButton} onClick={onContinue}>Pilih Repository <Icon name="arrow" /></button></> : <button className={styles.primaryButton} onClick={() => { connectRequested.current = true; onConnect(); }} disabled={state === "loading"}><Icon name="github" />{state === "error" || state === "denied" ? "Coba Lagi" : state === "loading" ? "Menghubungkan…" : "Hubungkan GitHub"}</button>}
      <div className={styles.cardDivider} /><p className={styles.caption}>Repository publik milik pihak lain dapat dipilih setelah login. Repository private tetap memerlukan izin yang sesuai.</p>
    </section>
  </div>;
}
