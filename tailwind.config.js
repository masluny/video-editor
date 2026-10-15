/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Steps between Tailwind's 5% ones that the UI uses (bg-accent/14, bg-panel-2/98, …).
      opacity: { 12: "0.12", 14: "0.14", 18: "0.18", 98: "0.98" },
      colors: {
        bg: { DEFAULT: "#0c0c0e", deep: "#08080a" },
        panel: { DEFAULT: "#141417", 2: "#18181c", 3: "#1e1e23" },
        line: { DEFAULT: "#26262c", soft: "#1f1f24", strong: "#34343c" },
        ink: { DEFAULT: "#ececf1", muted: "#a2a2ad", dim: "#6c6c78", faint: "#4a4a54" },
        accent: { DEFAULT: "#8b7cf6", hover: "#a092ff", deep: "#6b5ce0", ink: "#c9c1ff" },
        video: "#6f7dfb",
        audio: "#2fbf8f",
        title: "#e8a23d",
        danger: { DEFAULT: "#ef5b5b", hover: "#ff7676" },
        success: "#3ccf91",
        playhead: "#ff4f6d",
      },
      fontFamily: {
        sans: ['"Inter Variable"', "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ['"SF Mono"', "ui-monospace", "Menlo", "Consolas", "monospace"],
      },
      fontSize: {
        "2xs": ["10px", "14px"],
        xs: ["11px", "15px"],
        sm: ["12px", "17px"],
        base: ["13px", "19px"],
        md: ["14px", "20px"],
      },
      boxShadow: {
        pop: "0 18px 50px -12px rgba(0,0,0,0.75), 0 0 0 1px rgba(255,255,255,0.06)",
        glow: "0 0 0 1px rgba(139,124,246,0.45), 0 8px 24px -10px rgba(139,124,246,0.8)",
        inset: "inset 0 1px 0 rgba(255,255,255,0.035)",
      },
      keyframes: {
        fadeIn: { from: { opacity: "0" }, to: { opacity: "1" } },
        popIn: { from: { opacity: "0", transform: "translateY(6px) scale(0.985)" }, to: { opacity: "1", transform: "none" } },
        slideUp: { from: { opacity: "0", transform: "translateY(10px)" }, to: { opacity: "1", transform: "none" } },
        shimmer: { from: { backgroundPosition: "-200% 0" }, to: { backgroundPosition: "200% 0" } },
      },
      animation: {
        fadeIn: "fadeIn 120ms ease-out",
        popIn: "popIn 160ms cubic-bezier(0.16, 1, 0.3, 1)",
        slideUp: "slideUp 200ms cubic-bezier(0.16, 1, 0.3, 1)",
        shimmer: "shimmer 1.6s linear infinite",
      },
    },
  },
  plugins: [],
};
