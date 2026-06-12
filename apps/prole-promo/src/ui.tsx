import React from "react";
import { Img, staticFile, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { C, FONT } from "./theme";

export const BrandIcon: React.FC<{ size?: number; radius?: number }> = ({ size = 120, radius = 26 }) => (
  <Img
    src={staticFile("prole-icon.png")}
    style={{ width: size, height: size, borderRadius: radius, boxShadow: `0 20px 60px -18px ${C.accent}88` }}
  />
);

// macOS-style window chrome with traffic lights.
export const Window: React.FC<{
  width: number;
  height: number;
  title?: string;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ width, height, title, children, style }) => (
  <div
    style={{
      width,
      height,
      background: C.bg2,
      border: `1px solid ${C.border}`,
      borderRadius: 22,
      overflow: "hidden",
      boxShadow: "0 40px 120px -30px #000c",
      ...style,
    }}
  >
    <div
      style={{
        height: 52,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "0 20px",
        background: "#0f1116",
        borderBottom: `1px solid ${C.border}`,
      }}
    >
      <Dot color="#ff5f57" />
      <Dot color="#febc2e" />
      <Dot color="#28c840" />
      {title ? (
        <span style={{ color: C.dim, fontFamily: FONT, fontSize: 22, marginLeft: 16, fontWeight: 500 }}>{title}</span>
      ) : null}
    </div>
    <div style={{ position: "relative", width, height: height - 52 }}>{children}</div>
  </div>
);

const Dot: React.FC<{ color: string }> = ({ color }) => (
  <div style={{ width: 16, height: 16, borderRadius: "50%", background: color }} />
);

// A label chip ("1 · Snip it") that pops in.
export const Chip: React.FC<{ children: React.ReactNode; delay?: number }> = ({ children, delay = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 200 } });
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 14,
        padding: "16px 30px",
        borderRadius: 999,
        background: C.bg2,
        border: `1px solid ${C.border}`,
        fontFamily: FONT,
        fontSize: 34,
        fontWeight: 600,
        color: C.text,
        opacity: s,
        transform: `translateY(${interpolate(s, [0, 1], [30, 0])}px)`,
      }}
    >
      {children}
    </div>
  );
};

// Pointer cursor.
export const Cursor: React.FC<{ x: number; y: number; scale?: number }> = ({ x, y, scale = 1 }) => (
  <svg
    width={48 * scale}
    height={48 * scale}
    viewBox="0 0 24 24"
    style={{ position: "absolute", left: x, top: y, filter: "drop-shadow(0 2px 4px #000a)", zIndex: 50 }}
  >
    <path d="M5 3l14 8-6 1.5L9.5 19 5 3z" fill="#fff" stroke="#000" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
);

// Markup editor toolbar with the four tools; `active` highlights one.
const TOOLS = [
  { key: "rect", glyph: "▭" },
  { key: "arrow", glyph: "↗" },
  { key: "pen", glyph: "✎" },
  { key: "text", glyph: "T" },
];
export const Toolbar: React.FC<{ active: string }> = ({ active }) => (
  <div
    style={{
      display: "inline-flex",
      gap: 12,
      padding: 12,
      borderRadius: 18,
      background: "#0f1116ee",
      border: `1px solid ${C.border}`,
      backdropFilter: "blur(6px)",
    }}
  >
    {TOOLS.map((t) => (
      <div
        key={t.key}
        style={{
          width: 64,
          height: 64,
          display: "grid",
          placeItems: "center",
          borderRadius: 12,
          fontFamily: FONT,
          fontSize: 32,
          fontWeight: 700,
          color: active === t.key ? "#1a0f0a" : C.dim,
          background: active === t.key ? C.accent : "transparent",
          border: `1px solid ${active === t.key ? C.accent : C.border}`,
        }}
      >
        {t.glyph}
      </div>
    ))}
  </div>
);

// Reusable line-chart with a spike (the thing the user snips).
export const SpikeChart: React.FC<{ width: number; height: number; draw?: number }> = ({
  width,
  height,
  draw = 1,
}) => {
  const pad = 28;
  const pts = [0.62, 0.58, 0.64, 0.55, 0.6, 0.5, 0.12, 0.52, 0.49];
  const stepX = (width - pad * 2) / (pts.length - 1);
  const coords = pts.map((p, i) => [pad + i * stepX, pad + p * (height - pad * 2)]);
  const d = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x},${y}`).join(" ");
  return (
    <svg width={width} height={height}>
      {[0.25, 0.5, 0.75].map((g) => (
        <line key={g} x1={pad} x2={width - pad} y1={pad + g * (height - pad * 2)} y2={pad + g * (height - pad * 2)} stroke={C.border} strokeWidth={1} />
      ))}
      <path
        d={d}
        fill="none"
        stroke={C.blue}
        strokeWidth={6}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={2000}
        strokeDashoffset={2000 - draw * 2000}
      />
    </svg>
  );
};
