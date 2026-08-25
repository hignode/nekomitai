/**
 * Custom inline SVG icons — replaces the emoji glyphs (🛡 ☆ 🎨 🔊 🔇),
 * which render inconsistently inside CEP's Chromium. All icons draw with
 * currentColor so they follow the AE-derived panel theme.
 */

type IconProps = { size?: number };

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
});

/** Ad/tracker blocking badge */
export const IconShield = ({ size = 12 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M8 1.5 13.5 3.6v4.1c0 3.2-2.3 5.6-5.5 6.8-3.2-1.2-5.5-3.6-5.5-6.8V3.6L8 1.5Z" />
    <path d="m5.8 8 1.6 1.6 2.9-3.2" />
  </svg>
);

/** Save to reference board */
export const IconStar = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}>
    <path d="m8 1.8 1.9 3.9 4.3.6-3.1 3 .7 4.2L8 11.5l-3.8 2 .7-4.2-3.1-3 4.3-.6L8 1.8Z" />
  </svg>
);

/** Eyedrop a color into a solid */
export const IconEyedrop = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}>
    <path d="m9.3 4.3 2.4 2.4M13.6 2.4a1.7 1.7 0 0 0-2.4 0L9.9 3.7l2.4 2.4 1.3-1.3a1.7 1.7 0 0 0 0-2.4Z" />
    <path d="M10.5 5.5 4.2 11.8c-.3.3-.7.5-1.1.6l-1.6.3.3-1.6c.1-.4.3-.8.6-1.1l6.3-6.3" />
  </svg>
);

/** Reference volume — audible */
export const IconVolume = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M2 6.2h2.4L8 3.2v9.6L4.4 9.8H2V6.2Z" />
    <path d="M10.3 5.8a3 3 0 0 1 0 4.4M12.2 4a5.6 5.6 0 0 1 0 8" />
  </svg>
);

/** Reference volume — muted */
export const IconVolumeMuted = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M2 6.2h2.4L8 3.2v9.6L4.4 9.8H2V6.2Z" />
    <path d="m10.4 6.2 3.6 3.6M14 6.2l-3.6 3.6" />
  </svg>
);

/** Auto-duck: reference volume drops while AE plays */
export const IconDuck = ({ size = 13 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M1.6 6.2H4L7.4 3.2v9.6L4 9.8H1.6V6.2Z" />
    <path d="M11.8 3.6v6.9" />
    <path d="m9.5 8.4 2.3 2.3 2.3-2.3" />
  </svg>
);
