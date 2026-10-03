/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Brand colors from SPEC
        'decoricks-black': '#0A0908',
        'decoricks-dark': '#2B2B2B',
        'decoricks-light': '#F2F4F3',
        'decoricks-brown': '#806351',
        'decoricks-brown-dark': '#634D3D',
      },
      spacing: {
        // Design tokens for spacing
        'xs': '0.25rem',   // 4px
        'sm': '0.5rem',    // 8px
        'md': '1rem',      // 16px
        'lg': '1.5rem',    // 24px
        'xl': '2rem',      // 32px
        '2xl': '3rem',     // 48px
        '3xl': '4rem',     // 64px
      },
      borderRadius: {
        // Design tokens for radius
        'sm': '0.25rem',   // 4px
        'md': '0.5rem',    // 8px
        'lg': '0.75rem',   // 12px
        'xl': '1rem',      // 16px
        '2xl': '1.5rem',   // 24px
      },
      boxShadow: {
        // Design tokens for shadows (Liquid Glass style)
        'glass': '0 4px 6px -1px rgba(10, 9, 8, 0.1), 0 2px 4px -1px rgba(10, 9, 8, 0.06)',
        'glass-lg': '0 10px 15px -3px rgba(10, 9, 8, 0.1), 0 4px 6px -2px rgba(10, 9, 8, 0.05)',
        'glass-xl': '0 20px 25px -5px rgba(10, 9, 8, 0.1), 0 10px 10px -5px rgba(10, 9, 8, 0.04)',
      },
      backdropBlur: {
        'glass': '12px',
      },
    },
  },
  plugins: [],
}
