/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: { DEFAULT: "#0d0d0f", secondary: "#151517", tertiary: "#1d1d21" },
        surface: { DEFAULT: "#18181b", hover: "#222227", active: "#2b2b31" },
        panel: { DEFAULT: "#1b1b1f", raised: "#202027" },
        border: { DEFAULT: "#303037", hover: "#464650" },
        accent: { DEFAULT: "#4f8cff", hover: "#77a7ff", muted: "#2f5ea8" },
        text: { DEFAULT: "#f0f0f2", muted: "#a0a0aa", dim: "#686873" },
        clip: { video: "#5b7cfa", audio: "#22c55e", title: "#f59e0b" },
        success: { DEFAULT: "#22c55e", hover: "#4ade80" },
        danger: { DEFAULT: "#ef4444", hover: "#f87171" },
      },
      fontSize: {
        "2xs": ["10px", "14px"],
        xs: ["11px", "16px"],
        sm: ["13px", "18px"],
        base: ["14px", "20px"],
      },
      fontFamily: {
        sans: ['"Inter"', "system-ui", "-apple-system", "sans-serif"],
        mono: ['"JetBrains Mono"', '"SF Mono"', "ui-monospace", "monospace"],
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(79,140,255,0.34), 0 14px 34px -16px rgba(79,140,255,0.8)",
        panel: "0 1px 0 0 rgba(255,255,255,0.04) inset, 0 18px 54px -32px rgba(0,0,0,0.85)",
        inset: "inset 0 1px 0 rgba(255,255,255,0.04)",
      },
      keyframes: {
        fadeIn: { from: { opacity: "0" }, to: { opacity: "1" } },
        scaleIn: {
          from: { opacity: "0", transform: "translateY(8px) scale(0.98)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        shimmer: { "100%": { transform: "translateX(100%)" } },
      },
      animation: {
        fadeIn: "fadeIn 0.15s ease-out",
        scaleIn: "scaleIn 0.18s cubic-bezier(0.16, 1, 0.3, 1)",
      },
    },
  },
  plugins: [],
};
