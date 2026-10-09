/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      /*
       * Every colour resolves to a CSS custom property declared in
       * src/app/globals.css. The hex values live there and nowhere else, so a
       * palette change is a one-file edit and there is no second copy to drift.
       */
      colors: {
        // Brand palette — the only colours in the system.
        'decoricks-black': 'var(--color-black)',
        'decoricks-dark': 'var(--color-dark)',
        'decoricks-light': 'var(--color-light)',
        'decoricks-brown': 'var(--color-brown)',
        'decoricks-brown-dark': 'var(--color-brown-dark)',

        // Semantic aliases so components never reference a brand role directly.
        surface: {
          app: 'var(--surface-app)',
          raised: 'var(--surface-raised)',
          sunken: 'var(--surface-sunken)',
          overlay: 'var(--surface-overlay)',
          inverse: 'var(--surface-inverse)',
        },
        line: {
          subtle: 'var(--border-subtle)',
          DEFAULT: 'var(--border-default)',
          strong: 'var(--border-strong)',
        },
        ink: {
          DEFAULT: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          muted: 'var(--text-muted)',
          inverse: 'var(--text-inverse)',
        },
        status: {
          success: 'var(--status-success)',
          'success-bg': 'var(--status-success-bg)',
          warning: 'var(--status-warning)',
          'warning-bg': 'var(--status-warning-bg)',
          danger: 'var(--status-danger)',
          'danger-bg': 'var(--status-danger-bg)',
          info: 'var(--status-info)',
          'info-bg': 'var(--status-info-bg)',
        },
      },

      /*
       * NOTE: a previous version of this file overrode `spacing` with remapped
       * sm/md/lg/xl/2xl/3xl values. That silently changed the meaning of every
       * spacing utility carrying those names while leaving the rest of the scale
       * untouched, so `gap-2` and `gap-md` came from two different systems.
       * Tailwind's default spacing scale is used as-is and layout rhythm comes
       * from the custom properties in globals.css.
       */

      borderRadius: {
        // Restrained. Nothing exceeds 10px; pills are opt-in via `rounded-full`.
        'sm': '0.25rem',
        'DEFAULT': '0.375rem',
        'md': '0.375rem',
        'lg': '0.5rem',
        'xl': '0.625rem',
        '2xl': '0.75rem',
        '3xl': '0.75rem',
        'full': '9999px', // pills, avatars and status dots only
      },

      boxShadow: {
        // One restrained scale. Overlays only — static surfaces use a border.
        // The previous `glass`/`glass-lg`/`glass-xl` keys are gone: they only
        // existed to support translucent panels, which this system does not have.
        'xs': '0 1px 2px rgba(10, 9, 8, 0.04)',
        'sm': '0 1px 3px rgba(10, 9, 8, 0.06), 0 1px 2px rgba(10, 9, 8, 0.04)',
        'md': '0 6px 16px rgba(10, 9, 8, 0.1), 0 2px 6px rgba(10, 9, 8, 0.06)',
        'lg': '0 16px 40px rgba(10, 9, 8, 0.14), 0 4px 12px rgba(10, 9, 8, 0.08)',
      },

      fontSize: {
        /*
         * Explicit type scale. `base` is 14px to match the body size declared in
         * globals.css — leaving the default 16px meant form controls and buttons
         * rendered a full step larger than the text around them.
         */
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
        xs: ['0.75rem', { lineHeight: '1rem' }],
        sm: ['0.8125rem', { lineHeight: '1.125rem' }],
        base: ['0.875rem', { lineHeight: '1.375rem' }],
        md: ['0.9375rem', { lineHeight: '1.5rem' }],
        lg: ['1.0625rem', { lineHeight: '1.5rem' }],
        xl: ['1.25rem', { lineHeight: '1.75rem' }],
        '2xl': ['1.5rem', { lineHeight: '2rem' }],
        '3xl': ['1.875rem', { lineHeight: '2.25rem' }],
      },

      maxWidth: {
        // Content ceiling used by the shared page container.
        page: 'var(--layout-page-max)',
      },

      spacing: {
        // Layout dimensions, driven by the same tokens as globals.css.
        sidebar: 'var(--layout-sidebar-w)',
        'sidebar-collapsed': 'var(--layout-sidebar-w-collapsed)',
        drawer: 'var(--layout-drawer-w)',
        header: 'var(--layout-header-h)',
      },

      transitionDuration: {
        DEFAULT: '180ms',
        150: '150ms',
        240: '240ms',
      },

      /*
       * No `backdropBlur` entries: this system uses opaque surfaces, so a blur
       * utility anywhere would be a bug rather than a style choice.
       */
    },
  },
  plugins: [],
}