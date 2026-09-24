import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };
const base = (size = 18) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  'aria-hidden': true,
  fill: 'none',
});
const stroke = {
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export const IconChat = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path
      {...stroke}
      d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4A1.5 1.5 0 0 1 4 14.5z"
    />
    <path {...stroke} d="M8.5 9.5h7M8.5 12.5h4" />
  </svg>
);
export const IconCheck = ({ size = 17, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path {...stroke} strokeWidth={2.4} d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);
export const IconSearch = ({ size = 16, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <circle {...stroke} cx="11" cy="11" r="6.5" />
    <path {...stroke} d="M16 16l4 4" />
  </svg>
);
export const IconUndo = ({ size = 17, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path {...stroke} d="M9 7L4.5 11.5 9 16" />
    <path {...stroke} d="M5 11.5h9a5 5 0 0 1 0 10h-2" />
  </svg>
);
export const IconNote = ({ size = 17, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path {...stroke} d="M5 4h10l4 4v12H5z" />
    <path {...stroke} d="M8.5 12h7M8.5 16h5" />
  </svg>
);
export const IconDown = ({ size = 16, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path {...stroke} d="M12 4v11M7 10.5l5 5 5-5M5 20h14" />
  </svg>
);
export const IconPlus = ({ size = 16, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path {...stroke} strokeWidth={2.2} d="M12 5v14M5 12h14" />
  </svg>
);
export const IconFile = ({ size = 30, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path {...stroke} strokeWidth={1.6} d="M6 3h8l4 4v14H6z" />
    <path {...stroke} strokeWidth={1.6} d="M14 3v4h4M9 12h6M9 15h6M9 18h4" />
  </svg>
);
export const IconDots = ({ size = 18, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <circle cx="5" cy="12" r="1.8" fill="currentColor" />
    <circle cx="12" cy="12" r="1.8" fill="currentColor" />
    <circle cx="19" cy="12" r="1.8" fill="currentColor" />
  </svg>
);
export const IconHistory = ({ size = 17, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path {...stroke} d="M3.5 12a8.5 8.5 0 1 0 2.5-6" />
    <path {...stroke} d="M3.5 4v4h4M12 8v4.5l3 2" />
  </svg>
);
export const IconX = ({ size = 18, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path {...stroke} d="M6 6l12 12M18 6L6 18" />
  </svg>
);
export const IconFocus = ({ size = 17, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path {...stroke} d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" />
    <circle {...stroke} cx="12" cy="12" r="2.5" />
  </svg>
);
export const IconArrowRight = ({ size = 17, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path {...stroke} d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);
export const IconCopy = ({ size = 16, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <rect {...stroke} x="8" y="8" width="12" height="12" rx="2" />
    <path {...stroke} d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
  </svg>
);
export const IconBlock = ({ size = 17, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <circle {...stroke} cx="12" cy="12" r="8.5" />
    <path {...stroke} d="M6 18L18 6" />
  </svg>
);
export const IconClock = ({ size = 16, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <circle {...stroke} cx="12" cy="12" r="8.5" />
    <path {...stroke} d="M12 7.5V12l3 2" />
  </svg>
);
export const IconRefresh = ({ size = 16, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path {...stroke} d="M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20v-4h-4" />
  </svg>
);

const icon =
  (paths: string[], extra?: (p: P) => React.ReactNode, def = 18) =>
  ({ size = def, ...p }: P) => (
    <svg {...base(size)} {...p}>
      {paths.map((d) => (
        <path key={d} {...stroke} d={d} />
      ))}
      {extra?.(p)}
    </svg>
  );

export const IconInbox = icon([
  'M22 12h-6l-2 3h-4l-2-3H2',
  'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
]);
export const IconCheckCircle = icon(['M22 11.1V12a10 10 0 1 1-5.93-9.14', 'M9 11l3 3L22 4']);
export const IconChart = icon(['M3 3v16a2 2 0 0 0 2 2h16', 'M18 17V9', 'M13 17V5', 'M8 17v-3']);
export const IconBuilding = icon([
  'M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z',
  'M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2',
  'M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2',
  'M10 6h4M10 10h4M10 14h4M10 18h4',
]);
export const IconLayers = icon([
  'M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z',
  'm22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65',
  'm22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65',
]);
export const IconUsers = icon([
  'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2',
  'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  'M22 21v-2a4 4 0 0 0-3-3.87',
  'M16 3.13a4 4 0 0 1 0 7.75',
]);
export const IconShield = icon([
  'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z',
  'm9 12 2 2 4-4',
]);
export const IconSettings = icon([
  'M20 7h-9',
  'M14 17H5',
  'M17 20a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  'M7 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
]);
export const IconUser = icon([
  'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2',
  'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
]);
export const IconLogout = icon(
  ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'm16 17 5-5-5-5', 'M21 12H9'],
  undefined,
  17,
);
export const IconMenu = icon(['M4 6h16', 'M4 12h16', 'M4 18h16'], undefined, 20);
export const IconSun = icon(
  [
    'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
    'M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41',
  ],
  undefined,
  16,
);
export const IconMoon = icon(['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z'], undefined, 16);
export const IconMonitor = icon(
  ['M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z', 'M8 21h8M12 17v4'],
  undefined,
  16,
);
export const IconPhone = icon(
  [
    'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z',
  ],
  undefined,
  14,
);
export const IconBell = icon(['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 0 0 3.4 0']);
export const IconGrid = icon(['M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M4 14h6v6H4z', 'M14 14h6v6h-6z']);
export const IconUpload = icon(['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm17 8-5-5-5 5', 'M12 3v12']);
export const IconChevron = icon(['m6 9 6 6 6-6'], undefined, 16);
export const IconSparkle = icon(
  ['M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8'],
  undefined,
  16,
);

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true">
      <rect width="28" height="28" rx="8" style={{ fill: 'var(--accent)' }} />
      <g style={{ fill: 'var(--accent-ink)' }}>
        <rect x="7" y="8" width="9" height="2.6" rx="1.3" />
        <rect x="7" y="12.7" width="7" height="2.6" rx="1.3" opacity=".7" />
        <rect x="7" y="17.4" width="5" height="2.6" rx="1.3" opacity=".45" />
      </g>
      <path
        d="M15.6 17.2l2.4 2.4 4.4-5"
        fill="none"
        style={{ stroke: 'var(--accent-ink)' }}
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
