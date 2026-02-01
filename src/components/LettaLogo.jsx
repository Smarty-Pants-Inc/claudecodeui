import React from 'react';
import { useTheme } from '../contexts/ThemeContext';

// Simple inline SVG logo for Letta Code.
// We intentionally avoid adding new static assets under /public/icons.
const LettaLogo = ({ className = 'w-5 h-5' }) => {
  const { isDarkMode } = useTheme();

  // Slightly different green for dark mode so it doesn't glow too much.
  const background = isDarkMode ? '#059669' : '#10b981';

  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      role="img"
      aria-label="Letta Code"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="2" y="2" width="20" height="20" rx="6" fill={background} />
      {/* Stylized "L" */}
      <path
        d="M8 7.5c0-.55.45-1 1-1h1c.55 0 1 .45 1 1V16h4.5c.55 0 1 .45 1 1v.5c0 .55-.45 1-1 1H9c-.55 0-1-.45-1-1V7.5z"
        fill="#ffffff"
      />
    </svg>
  );
};

export default LettaLogo;
