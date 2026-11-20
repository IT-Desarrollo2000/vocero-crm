"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export const SHOW_PASSWORD_LABEL = "Mostrar contraseña";
export const HIDE_PASSWORD_LABEL = "Ocultar contraseña";

/**
 * 037 — Campo de contraseña con ojo para verla. Mismas props que `Input`
 * (sin `type`). El botón no envía el formulario ni le quita el foco al campo
 * (ni le mueve el cursor), y al enviar el formulario la contraseña vuelve a
 * ocultarse. Solo para contraseñas de cuenta: los tokens y secretos NO lo usan.
 */
export function PasswordInput({
  className,
  ref,
  disabled,
  ...props
}: Omit<React.ComponentPropsWithRef<"input">, "type">) {
  const [visible, setVisible] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Selección del campo justo antes de alternar: cambiar `type` puede moverla.
  const selection = useRef<[number | null, number | null] | null>(null);

  // Combina el ref externo (React 19: `ref` como prop) con el interno.
  const setRefs = useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node;
      if (typeof ref === "function") return ref(node);
      if (ref) ref.current = node;
    },
    [ref]
  );

  // Al enviar el formulario que lo contiene, vuelve a ocultarse.
  useEffect(() => {
    const form = inputRef.current?.form;
    if (!form) return;
    const hide = () => setVisible(false);
    form.addEventListener("submit", hide);
    return () => form.removeEventListener("submit", hide);
  }, []);

  useLayoutEffect(() => {
    const input = inputRef.current;
    const sel = selection.current;
    selection.current = null;
    if (!input || !sel || document.activeElement !== input) return;
    const restore = () => {
      if (document.activeElement !== input) return;
      try {
        input.setSelectionRange(sel[0], sel[1]);
      } catch {
        // Un campo sin selección posible no es motivo para fallar.
      }
    };
    restore();
    // Chromium reinicia la selección al cambiar `type` DESPUÉS del commit
    // (en el siguiente cálculo de estilo): se repite en el próximo cuadro.
    const raf = requestAnimationFrame(restore);
    return () => cancelAnimationFrame(raf);
  }, [visible]);

  function toggle() {
    const input = inputRef.current;
    selection.current = input ? [input.selectionStart, input.selectionEnd] : null;
    setVisible((v) => !v);
  }

  return (
    <div className="relative">
      <Input
        {...props}
        ref={setRefs}
        type={visible ? "text" : "password"}
        disabled={disabled}
        className={cn("pr-10", className)}
      />
      <button
        type="button"
        aria-label={visible ? HIDE_PASSWORD_LABEL : SHOW_PASSWORD_LABEL}
        aria-pressed={visible}
        disabled={disabled}
        // Sin esto el clic se llevaría el foco (y el cursor) del campo.
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggle}
        className={cn(
          "absolute right-0 top-0 flex h-9 w-10 items-center justify-center rounded-r-md transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          visible ? "text-foreground" : "text-text-3"
        )}
      >
        {visible ? (
          <EyeOff className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
        ) : (
          <Eye className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
