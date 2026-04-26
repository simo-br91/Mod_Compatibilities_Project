import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        critical: "#dc2626",
        high: "#ea580c",
        medium: "#ca8a04",
        low: "#2563eb",
        info: "#6b7280",
        mc: {
          bg: "#1a1a1a",
          panel: "#2d2d2d",
          border: "#555555",
          "border-light": "#888888",
          green: "#5ab552",
          "green-dark": "#3d7a19",
          "green-hover": "#6dc764",
          stone: "#8b8b8b",
          "stone-dark": "#444444",
          dirt: "#916040",
          gold: "#f7a01c",
          text: "#ffffff",
          "text-muted": "#aaaaaa",
          "text-dim": "#777777",
          danger: "#e74c3c",
          "danger-dark": "#c0392b",
        },
      },
      fontFamily: {
        minecraft: ["'VT323'", "monospace"],
      },
      boxShadow: {
        "mc-btn": "2px 2px 0px #000000, inset 1px 1px 0px rgba(255,255,255,0.15)",
        "mc-btn-hover": "1px 1px 0px #000000, inset 1px 1px 0px rgba(255,255,255,0.2)",
        "mc-inset": "inset 2px 2px 0px rgba(0,0,0,0.6), inset -1px -1px 0px rgba(255,255,255,0.05)",
        "mc-panel": "4px 4px 0px #000000",
      },
    },
  },
  plugins: [],
};

export default config;
