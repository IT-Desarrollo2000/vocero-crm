import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** `/reports` abre la pestaña «Resumen» (021), conservando el rango del enlace. */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === "string") params.set(key, value);
  }
  const qs = params.toString();
  redirect(qs ? `/reports/summary?${qs}` : "/reports/summary");
}
