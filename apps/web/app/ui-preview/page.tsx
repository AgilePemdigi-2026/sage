import type { Metadata } from "next";
import { PreviewClient } from "./preview-client";
export const metadata: Metadata = {
  title: "SAGE — Pratinjau fondasi antarmuka",
  description: "Pratinjau komponen login, target repository, dan progres dengan data contoh.",
  robots: { index: false, follow: false },
};
export default function UiPreviewPage() { return <PreviewClient />; }
