import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

/**
 * Los nombres semánticos existentes (background, primary, muted…) se remapean
 * a los tokens del sistema Atlas para que toda la app comparta el tema activo
 * (claro u oscuro, ver globals.css); la escala `brand-*` expone el acento
 * white-label y las escalas de estado exponen la tríada tint/soft/text.
 *
 * Dos reglas para no romper el tema oscuro:
 * 1. Nada de colores literales en la UI (`text-white`, `bg-black`, hex suelto).
 *    Excepción deliberada: la paleta de identidad (avatares, puntos de etapa,
 *    palomita azul de WhatsApp) son tonos medios legibles en ambos temas.
 * 2. Nada de modificador de opacidad (`bg-brand/20`) sobre estos nombres:
 *    Tailwind 3 no sabe aplicarlo a un color `var(--x)` y descarta la regla en
 *    silencio. Usa un token propio (p. ej. `--accent-veil`) o `opacity-*`.
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "var(--border)",
        "border-strong": "var(--border-strong)",
        input: "var(--border-strong)",
        ring: "var(--accent)",
        background: "var(--bg)",
        foreground: "var(--text)",
        subtle: "var(--bg-subtle)",
        primary: {
          DEFAULT: "var(--accent)",
          foreground: "var(--accent-fg)",
        },
        secondary: {
          DEFAULT: "var(--bg-panel)",
          foreground: "var(--text-2)",
        },
        destructive: {
          DEFAULT: "var(--danger)",
          foreground: "var(--danger-fg)",
        },
        muted: {
          DEFAULT: "var(--bg-panel)",
          foreground: "var(--text-3)",
        },
        accent: {
          DEFAULT: "var(--bg-hover)",
          foreground: "var(--text)",
        },
        card: {
          DEFAULT: "var(--bg)",
          foreground: "var(--text)",
        },
        popover: {
          DEFAULT: "var(--bg)",
          foreground: "var(--text)",
        },
        brand: {
          DEFAULT: "var(--accent)",
          hover: "var(--accent-hover)",
          soft: "var(--accent-soft)",
          tint: "var(--accent-tint)",
          text: "var(--accent-text)",
          fg: "var(--accent-fg)",
          veil: "var(--accent-veil)",
        },
        "text-2": "var(--text-2)",
        "text-3": "var(--text-3)",
        "text-4": "var(--text-4)",
        chat: "var(--chat-bg)",
        "bubble-out": "var(--bubble-out)",
        "bubble-out-text": "var(--bubble-out-text)",
        success: {
          DEFAULT: "var(--success)",
          tint: "var(--success-tint)",
          soft: "var(--success-soft)",
          text: "var(--success-text)",
        },
        warning: {
          DEFAULT: "var(--warning)",
          tint: "var(--warning-tint)",
          soft: "var(--warning-soft)",
          text: "var(--warning-text)",
        },
        danger: {
          DEFAULT: "var(--danger)",
          tint: "var(--danger-tint)",
          soft: "var(--danger-soft)",
          text: "var(--danger-text)",
        },
        info: {
          DEFAULT: "var(--info)",
          tint: "var(--info-tint)",
          soft: "var(--info-soft)",
          text: "var(--info-text)",
        },
        overlay: "var(--overlay)",
        knob: "var(--knob)",
        video: "var(--video-bg)",
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius)",
        lg: "var(--radius-lg)",
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        pop: "var(--shadow-pop)",
      },
      fontFamily: {
        sans: ["var(--font-geist)", "Hanken Grotesk", "-apple-system", "sans-serif"],
      },
    },
  },
  plugins: [animate],
};

export default config;
