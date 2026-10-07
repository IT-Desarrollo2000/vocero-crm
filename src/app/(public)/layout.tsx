import Link from "next/link";
import { LEGAL } from "@/lib/legal";

const LINK =
  "underline underline-offset-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";

export default function PublicLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-screen flex-col bg-subtle text-foreground">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-4">
          <span
            aria-hidden="true"
            className="flex h-8 w-8 items-center justify-center rounded-md bg-brand text-base font-bold text-brand-fg"
          >
            F
          </span>
          <span className="text-base font-semibold tracking-tight">
            {LEGAL.productName}
          </span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
        {children}
      </main>
      <footer className="border-t border-border bg-background">
        <div className="mx-auto w-full max-w-3xl px-4 py-6 text-sm text-muted-foreground">
          <nav aria-label="Páginas legales">
            <ul className="flex flex-wrap gap-x-5 gap-y-2">
              <li>
                <Link className={LINK} href="/privacidad">
                  Política de privacidad
                </Link>
              </li>
              <li>
                <Link className={LINK} href="/terminos">
                  Términos del servicio
                </Link>
              </li>
              <li>
                <Link className={LINK} href="/eliminacion-datos">
                  Eliminación de datos
                </Link>
              </li>
            </ul>
          </nav>
          <p className="mt-3">
            {LEGAL.productName} — {LEGAL.businessName}
          </p>
        </div>
      </footer>
    </div>
  );
}
