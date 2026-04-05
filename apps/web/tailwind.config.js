/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      boxShadow: {
        glow: "0 0 0 1px rgba(56, 189, 248, 0.18), 0 24px 80px rgba(2, 6, 23, 0.55)",
      },
    },
  },
  plugins: [],
};