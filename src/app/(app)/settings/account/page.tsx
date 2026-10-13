import { headers } from "next/headers";
import { getAuth } from "@/lib/auth";
import { AccountClient } from "@/components/settings/account-client";

// "Mi cuenta" (dev-tasks/00, RF-00-16): la única pestaña de Ajustes común a
// ambos roles, por eso vive FUERA de `(owner)`. La sesión ya la exige
// `(app)/layout.tsx`.
export const dynamic = "force-dynamic";

export default async function AccountSettingsPage() {
  const authSession = await getAuth().api.getSession({
    headers: await headers(),
  });
  return (
    <AccountClient
      initialName={authSession?.user.name ?? ""}
      email={authSession?.user.email ?? ""}
    />
  );
}
