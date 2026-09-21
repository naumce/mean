/** @type {import('tailwindcss').Config} */
// Semantic tokens read CSS variables (see src/assets/main.css) so one class
// works in both modes: `bg-surface`, `text-ink-2`, `border-line`, `bg-s-progress/10`.
const tk = (name) => `rgb(var(--tk-${name}) / <alpha-value>)`

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{vue,ts}'],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#eff6ff',
          100: '#dbeafe',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
          800: '#1e40af',
        },
        gray: {
          50: '#f9fafb',
          100: '#f3f4f6',
          200: '#e5e7eb',
          300: '#d1d5db',
          400: '#9ca3af',
          500: '#6b7280',
          600: '#4b5563',
          700: '#374151',
          800: '#1f2937',
          900: '#111827',
        },
        // --- semantic tokens (light/dark via CSS variables) ---
        bg: tk('bg'),
        surface: { DEFAULT: tk('surface'), 2: tk('surface-2'), 3: tk('surface-3') },
        line: { DEFAULT: tk('line'), strong: tk('line-strong') },
        ink: { DEFAULT: tk('ink'), 2: tk('ink-2'), 3: tk('ink-3') },
        brand: { DEFAULT: tk('brand'), ink: tk('brand-ink'), wash: tk('brand-wash') },
        's-assigned': tk('s-assigned'),
        's-progress': tk('s-progress'),
        's-completed': tk('s-completed'),
        's-tendered': tk('s-tendered'),
        's-open': tk('s-open'),
        haz: tk('haz'),
        conflict: tk('conflict'),
        // Spot-search accent. Per-palette so it stays legible as *text*: the
        // dark palette's yellow is unreadable on light surfaces.
        spot: tk('spot'),
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
}
