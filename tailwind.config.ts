import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Ultra-dark premium surfaces
        void: {
          950: "#09090b", // page background
          900: "#0c0c0f",
          800: "#141416",
          700: "#1c1c1f",
        },
        // Electric blue accent
        electric: {
          300: "#7dd3fc",
          400: "#38bdf8",
          500: "#0ea5e9",
          DEFAULT: "#0ea5e9",
        },
        // Neon purple accent
        plasma: {
          300: "#c4b5fd",
          400: "#a78bfa",
          500: "#a855f7",
          DEFAULT: "#a855f7",
        },
        gradient: {
          start: "#38bdf8",
          end: "#a855f7",
        },
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "Inter", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "ui-monospace", "monospace"],
      },
      borderRadius: {
        // Standardized 8px rounding everywhere (matches Tailwind's `rounded-lg`)
        card: "8px",
      },
      backgroundImage: {
        "electric-border":
          "conic-gradient(from var(--shimmer-angle), transparent 0deg, transparent 140deg, #38bdf8 165deg, #a855f7 200deg, transparent 235deg, transparent 360deg)",
      },
      boxShadow: {
        glow: "0 0 24px -6px rgba(56, 189, 248, 0.35)",
        "glow-purple": "0 0 24px -6px rgba(168, 85, 247, 0.35)",
        inner: "inset 0 0 0 1px rgba(255, 255, 255, 0.03)",
      },
      keyframes: {
        // Continuous rotation of the shimmering outline. Spun on an oversized
        // conic-gradient pseudo-element so the arc sweeps the card's perimeter.
        shimmer: {
          "0%": {
            transform: "rotate(0deg)",
          },
          "100%": {
            transform: "rotate(360deg)",
          },
        },
        shimmerReversed: {
          "0%": {
            transform: "rotate(360deg)",
          },
          "100%": {
            transform: "rotate(0deg)",
          },
        },
        // Slow pulsing glow behind stats
        pulseGlow: {
          "0%, 100%": {
            opacity: "0.4",
          },
          "50%": {
            opacity: "1",
          },
        },
        // Gentle float for hero content
        float: {
          "0%, 100%": {
            transform: "translateY(0px)",
          },
          "50%": {
            transform: "translateY(-6px)",
          },
        },
        fadeUp: {
          "0%": {
            opacity: "0",
            transform: "translateY(8px)",
          },
          "100%": {
            opacity: "1",
            transform: "translateY(0)",
          },
        },
      },
      animation: {
        // 7s full perimeter rotation (~51deg/s) — smooth, not frantic
        shimmer: "shimmer 7s linear infinite",
        "shimmer-reversed": "shimmerReversed 9s linear infinite",
        "pulse-glow": "pulseGlow 4s ease-in-out infinite",
        float: "float 6s ease-in-out infinite",
        "fade-up": "fadeUp 0.6s ease-out both",
      },
    },
  },
  plugins: [],
};

export default config;