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

// Real Prole editor icons (stroke paths, matching apps/prole/src/editor.html).
const ICON_PATHS: Record<string, React.ReactNode> = {
  rect: <rect x="4" y="6" width="16" height="12" rx="1.5" />,
  arrow: (
    <>
      <path d="M5 19 L19 5" />
      <path d="M11 5 H19 V13" />
    </>
  ),
  pen: <path d="M14 4l6 6M3.5 20.5l1.2-4.2L15 6l3 3-10.3 10.3z" />,
  text: <path d="M5 6V5h14v1M12 5v14M9 19h6" />,
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
};

const ToolGlyph: React.FC<{ name: string; size?: number; color: string }> = ({ name, size = 36, color }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    style={{ fill: "none", stroke: color, strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }}
  >
    {ICON_PATHS[name]}
  </svg>
);

// Markup editor toolbar with the four real tools; `active` highlights one.
const TOOLS = ["rect", "arrow", "pen", "text"];
export const Toolbar: React.FC<{ active: string }> = ({ active }) => (
  <div
    style={{
      display: "inline-flex",
      gap: 12,
      padding: 12,
      borderRadius: 18,
      background: "#0f1116ee",
      border: `1px solid ${C.border}`,
    }}
  >
    {TOOLS.map((t) => {
      const on = active === t;
      return (
        <div
          key={t}
          style={{
            width: 64,
            height: 64,
            display: "grid",
            placeItems: "center",
            borderRadius: 12,
            background: on ? "rgba(217,119,87,0.16)" : "transparent",
            border: `1px solid ${on ? C.accent : C.border}`,
          }}
        >
          <ToolGlyph name={t} color={on ? C.accent : C.dim} />
        </div>
      );
    })}
  </div>
);

// The floating capture pill (matches apps/prole/src/floating.html): grip + accent snap button.
export const FloatingPill: React.FC<{ pressed?: boolean }> = ({ pressed = false }) => (
  <div
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 8,
      padding: "10px 14px",
      background: "rgba(28,28,31,0.96)",
      border: "1px solid rgba(255,255,255,0.10)",
      borderRadius: 46,
      boxShadow: "0 16px 46px rgba(0,0,0,0.55)",
    }}
  >
    <div style={{ display: "grid", placeItems: "center", width: 52, height: 76, color: C.dim }}>
      <svg width={52} height={52} viewBox="0 0 24 24" style={{ fill: "currentColor", stroke: "none" }}>
        <circle cx="9" cy="6" r="1.4" />
        <circle cx="9" cy="12" r="1.4" />
        <circle cx="9" cy="18" r="1.4" />
        <circle cx="15" cy="6" r="1.4" />
        <circle cx="15" cy="12" r="1.4" />
        <circle cx="15" cy="18" r="1.4" />
      </svg>
    </div>
    <div
      style={{
        width: 76,
        height: 76,
        display: "grid",
        placeItems: "center",
        borderRadius: "50%",
        background: pressed ? C.accentSoft : C.accent,
        transform: `scale(${pressed ? 0.9 : 1})`,
        boxShadow: pressed ? "none" : `0 8px 22px -6px ${C.accent}`,
      }}
    >
      <svg
        width={42}
        height={42}
        viewBox="0 0 24 24"
        style={{ fill: "none", stroke: "#fff", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }}
      >
        <path d="M4 9V6a2 2 0 0 1 2-2h3M15 4h3a2 2 0 0 1 2 2v3M20 15v3a2 2 0 0 1-2 2h-3M9 20H6a2 2 0 0 1-2-2v-3" />
        <circle cx="12" cy="12" r="2.5" />
      </svg>
    </div>
  </div>
);

// The real "Copy" primary button (accent background, white copy glyph + label).
export const CopyButton: React.FC<{ scale?: number; pressed?: boolean }> = ({ scale = 1, pressed = false }) => (
  <div
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 16,
      padding: "20px 34px",
      borderRadius: 16,
      background: pressed ? C.accentSoft : C.accent,
      border: `1px solid ${C.accent}`,
      transform: `scale(${scale * (pressed ? 0.96 : 1)})`,
      boxShadow: `0 16px 40px -14px ${C.accent}aa`,
    }}
  >
    <ToolGlyph name="copy" size={44} color="#fff" />
    <span style={{ fontFamily: FONT, fontWeight: 700, fontSize: 42, color: "#fff" }}>Copy</span>
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
