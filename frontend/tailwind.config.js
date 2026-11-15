/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        void: '#080A0D',
        fog: '#C9D3DB',
        haze: '#8FA0AE',
        ash: '#4A5560',
        ember: '#F0A04B',
        ice: '#82B4EB',
      },
      fontFamily: {
        sans: ['"IBM Plex Sans Condensed"', 'system-ui', 'sans-serif'],
        serif: ['Newsreader', 'Georgia', 'serif'],
      },
      borderRadius: { none: '0' },
      transitionTimingFunction: {
        cinema: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
};
