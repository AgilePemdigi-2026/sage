import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createPreviewData } from "../fixture-data.ts";
import { PreviewClient } from "../../../components/sprint-ui/preview-client.tsx";

export const metadata: Metadata = {
  title: "SAGE — Pratinjau Sprint 1",
  description: "Pratinjau UI dari fixture source code tervalidasi.",
  robots: { index: false, follow: false },
};

type PreviewPageProps = {
  params: Promise<{ screen: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};
const screens = ["progress", "history", "graph"] as const;

export default async function PreviewPage({ params, searchParams }: PreviewPageProps) {
  const { screen } = await params;
  const query = await searchParams;
  if (!screens.includes(screen as (typeof screens)[number])) notFound();
  if (query?.analysis !== undefined && query.analysis !== "fixture-report") notFound();
  return <PreviewClient screen={screen as (typeof screens)[number]} data={createPreviewData()} />;
}
