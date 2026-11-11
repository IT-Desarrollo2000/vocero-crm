import { ContactsClient } from "@/components/contacts/contacts-client";

export const dynamic = "force-dynamic";

/** 035: `?q=` llega ya escrito en el buscador («Escribir primero» desde Pendientes). */
export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { q } = await searchParams;
  return <ContactsClient initialQuery={typeof q === "string" ? q.slice(0, 120) : ""} />;
}
