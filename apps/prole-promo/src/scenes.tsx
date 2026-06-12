import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
  Easing,
} from "remotion";
import { C, FONT } from "./theme";
import { BrandIcon, Chip, Cursor, SpikeChart, Toolbar, Window } from "./ui";

const ease = (f: number, a: number[], b: number[]) =>
  interpolate(f, a, b, { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });

// Fades scene CONTENT in/out over a shared background so cuts never flash black.
const Content: React.FC<{ dur: number; children: React.ReactNode }> = ({ dur, children }) => {
  const frame = useCurrentFrame();
  const opacity = Math.min(ease(frame, [0, 8], [0, 1]), ease(frame, [dur - 8, dur], [1, 0]));
  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
};

const Center: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", ...style }}>{children}</AbsoluteFill>
);

const CHART_W = 820;
const CHART_H = 520;

/* ---------------- 1. HOOK ---------------- */
export const SceneHook: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 200 } });
  const scale = interpolate(pop, [0, 1], [0.9, 1]);
  return (
    <Content dur={dur}>
      <Center>
        <div style={{ transform: `scale(${scale})` }}>
          <Window width={CHART_W} height={CHART_H} title="Analytics · Traffic">
            <SpikeChart width={CHART_W} height={CHART_H - 52} draw={1} />
          </Window>
        </div>
        <Cursor x={CHART_W / 2 + 120} y={CHART_H / 2 + 260} />
      </Center>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "flex-start", paddingTop: 360 }}>
        <div
          style={{
            fontFamily: FONT,
            fontSize: 84,
            fontWeight: 800,
            color: C.text,
            letterSpacing: "-0.03em",
            textAlign: "center",
            opacity: ease(frame, [10, 28], [0, 1]),
            transform: `translateY(${ease(frame, [10, 28], [24, 0])}px)`,
          }}
        >
          spot something
          <br />
          <span style={{ color: C.accent }}>worth asking about?</span>
        </div>
      </AbsoluteFill>
    </Content>
  );
};

/* ---------------- 2. SNIP ---------------- */
export const SceneSnip: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  // Selection rectangle grows around the spike (right side of chart).
  const grow = ease(frame, [18, 58], [0, 1]);
  const selX = 470;
  const selY = 120;
  const selW = 280 * grow;
  const selH = 300 * grow;
  const cursorX = interpolate(grow, [0, 1], [selX - 30, selX + selW + 20]);
  const cursorY = interpolate(grow, [0, 1], [selY - 30, selY + selH + 20]);
  const dim = ease(frame, [18, 40], [0, 0.6]);
  return (
    <Content dur={dur}>
      <Center>
        <div style={{ position: "relative" }}>
          <Window width={CHART_W} height={CHART_H} title="Analytics · Traffic">
            <SpikeChart width={CHART_W} height={CHART_H - 52} draw={1} />
            {/* dim overlay with a clear hole would need masking; simple dim + bright box border reads fine */}
            <AbsoluteFill style={{ background: "#000", opacity: dim }} />
            <div
              style={{
                position: "absolute",
                left: selX,
                top: selY,
                width: selW,
                height: selH,
                border: `4px solid ${C.accent}`,
                borderRadius: 6,
                boxShadow: `0 0 0 9999px rgba(0,0,0,0)`,
                background: "rgba(217,119,87,0.08)",
              }}
            />
          </Window>
          <Cursor x={cursorX} y={cursorY + 52} />
        </div>
      </Center>
      <Label dur={dur}>1 · Snip anything</Label>
    </Content>
  );
};

/* ---------------- 3. ANNOTATE (arrow + TEXT TOOL on the image) ---------------- */
export const SceneAnnotate: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const cardW = 760;
  const cardH = 560;
  // arrow draw 14-46, text type 70-120
  const arrow = ease(frame, [14, 46], [0, 1]);
  const activeTool = frame < 60 ? "arrow" : "text";
  const note = "why the spike?";
  const chars = Math.round(ease(frame, [74, 118], [0, note.length]));
  const caret = frame > 70 && frame < 124 && Math.floor(frame / 8) % 2 === 0;

  const ax1 = 120, ay1 = 120, ax2 = 470, ay2 = 250;
  const ax = interpolate(arrow, [0, 1], [ax1, ax2]);
  const ay = interpolate(arrow, [0, 1], [ay1, ay2]);
  return (
    <Content dur={dur}>
      <Center>
        <div style={{ position: "relative" }}>
          <Window width={cardW} height={cardH} title="Prole · Markup">
            <div style={{ position: "relative", width: cardW, height: cardH - 52, background: C.bg }}>
              <SpikeChart width={cardW} height={cardH - 52} draw={1} />
              {/* arrow drawn by the arrow tool */}
              <svg width={cardW} height={cardH - 52} style={{ position: "absolute", inset: 0 }}>
                <defs>
                  <marker id="ah" markerWidth="10" markerHeight="10" refX="6" refY="3" orient="auto">
                    <path d="M0,0 L6,3 L0,6 Z" fill={C.accent} />
                  </marker>
                </defs>
                {arrow > 0.02 && (
                  <line x1={ax1} y1={ay1} x2={ax} y2={ay} stroke={C.accent} strokeWidth={7} strokeLinecap="round" markerEnd={arrow > 0.98 ? "url(#ah)" : undefined} />
                )}
              </svg>
              {/* TEXT TOOL: text written directly onto the image at a clicked point */}
              {frame > 70 && (
                <div
                  style={{
                    position: "absolute",
                    left: 150,
                    top: 300,
                    fontFamily: FONT,
                    fontWeight: 700,
                    fontSize: 40,
                    color: C.accent,
                    textShadow: "0 2px 8px #000a",
                  }}
                >
                  {note.slice(0, chars)}
                  <span style={{ opacity: caret ? 1 : 0, color: C.text }}>|</span>
                </div>
              )}
            </div>
          </Window>
          <div style={{ position: "absolute", bottom: -44, left: "50%", transform: "translateX(-50%)" }}>
            <Toolbar active={activeTool} />
          </div>
        </div>
      </Center>
      <Label dur={dur}>
        2 · {activeTool === "arrow" ? "Mark it up" : "Write right on it"}
      </Label>
    </Content>
  );
};

/* ---------------- 4. COPY ---------------- */
export const SceneCopy: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const press = spring({ frame: frame - 6, fps, config: { damping: 200 } });
  const shrink = ease(frame, [30, 60], [1, 0.42]);
  const lift = ease(frame, [30, 60], [0, -120]);
  const checkIn = spring({ frame: frame - 58, fps, config: { damping: 200 } });
  return (
    <Content dur={dur}>
      <Center>
        <div style={{ transform: `translateY(${lift}px) scale(${shrink})`, position: "relative" }}>
          <Window width={520} height={360} title="Prole · Markup">
            <div style={{ position: "relative", width: 520, height: 308, background: C.bg }}>
              <SpikeChart width={520} height={308} draw={1} />
              <div style={{ position: "absolute", left: 120, top: 200, fontFamily: FONT, fontWeight: 700, fontSize: 30, color: C.accent }}>
                why the spike?
              </div>
            </div>
          </Window>
        </div>
        {/* ⌘C key */}
        <div
          style={{
            position: "absolute",
            bottom: 520,
            transform: `scale(${interpolate(press, [0, 1], [0.6, 1])})`,
            opacity: ease(frame, [4, 14], [0, 1]) * ease(frame, [40, 56], [1, 0]),
            fontFamily: FONT,
            fontWeight: 700,
            fontSize: 44,
            color: C.text,
            background: C.bg3,
            border: `1px solid ${C.border}`,
            borderRadius: 16,
            padding: "16px 30px",
          }}
        >
          ⌘C
        </div>
        <div style={{ position: "absolute", bottom: 540, opacity: checkIn, fontFamily: FONT, fontWeight: 700, fontSize: 46, color: C.green }}>
          ✓ Copied
        </div>
      </Center>
      <Label dur={dur}>3 · Copy the image</Label>
    </Content>
  );
};

/* ---------------- 5. PASTE ANYWHERE ---------------- */
export const ScenePaste: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const drop = spring({ frame: frame - 6, fps, config: { damping: 200 } });
  const reply = "That spike is your Jun 3 launch, 4× your usual traffic.";
  const chars = Math.round(ease(frame, [70, 150], [0, reply.length]));
  const apps = ["Claude", "ChatGPT", "Slack", "Mail", "anywhere"];
  return (
    <Content dur={dur}>
      <Center style={{ justifyContent: "flex-start", paddingTop: 200 }}>
        <Window width={860} height={760} title="Claude">
          <div style={{ padding: 34, display: "flex", flexDirection: "column", gap: 22, height: 760 - 52 - 68 }}>
            {/* user message: the pasted image + a short ask */}
            <div style={{ alignSelf: "flex-end", maxWidth: 600, transform: `translateY(${interpolate(drop, [0, 1], [40, 0])}px)`, opacity: drop }}>
              <div style={{ borderRadius: 18, overflow: "hidden", border: `1px solid ${C.border}` }}>
                <Window width={420} height={230} title="">
                  <div style={{ position: "relative", width: 420, height: 178, background: C.bg }}>
                    <SpikeChart width={420} height={178} draw={1} />
                    <div style={{ position: "absolute", left: 90, top: 116, fontFamily: FONT, fontWeight: 700, fontSize: 22, color: C.accent }}>
                      why the spike?
                    </div>
                  </div>
                </Window>
              </div>
            </div>
            {/* Claude reply streaming in */}
            {frame > 66 && (
              <div style={{ alignSelf: "flex-start", maxWidth: 620, background: C.bg3, border: `1px solid ${C.border}`, borderRadius: 18, padding: "22px 26px", fontFamily: FONT, fontSize: 30, lineHeight: 1.45, color: C.text }}>
                {reply.slice(0, chars)}
              </div>
            )}
          </div>
        </Window>
      </Center>
      {/* paste-anywhere app row */}
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "flex-end", paddingBottom: 200 }}>
        <div style={{ display: "flex", gap: 14, opacity: ease(frame, [120, 145], [0, 1]) }}>
          {apps.map((a, i) => (
            <div
              key={a}
              style={{
                fontFamily: FONT,
                fontWeight: 600,
                fontSize: 28,
                color: a === "anywhere" ? C.accent : C.text,
                background: C.bg2,
                border: `1px solid ${a === "anywhere" ? C.accent : C.border}`,
                borderRadius: 999,
                padding: "12px 22px",
                transform: `translateY(${ease(frame, [120 + i * 4, 145 + i * 4], [16, 0])}px)`,
              }}
            >
              {a}
            </div>
          ))}
        </div>
      </AbsoluteFill>
      <Label dur={dur}>Paste it into Claude, or anywhere</Label>
    </Content>
  );
};

/* ---------------- 6. OUTRO ---------------- */
export const SceneOutro: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const icon = spring({ frame, fps, config: { damping: 200 } });
  return (
    <Content dur={dur}>
      <Center>
        <div style={{ transform: `scale(${interpolate(icon, [0, 1], [0.5, 1])})`, opacity: icon, marginBottom: 50 }}>
          <BrandIcon size={180} radius={40} />
        </div>
        <div style={{ fontFamily: FONT, fontWeight: 820, fontSize: 88, color: C.text, letterSpacing: "-0.035em", textAlign: "center", lineHeight: 1.05, opacity: ease(frame, [12, 30], [0, 1]), transform: `translateY(${ease(frame, [12, 30], [24, 0])}px)` }}>
          Snip anything on screen.
          <br />
          <span style={{ color: C.accent }}>Paste it anywhere.</span>
        </div>
        <div style={{ fontFamily: FONT, fontSize: 34, color: C.dim, marginTop: 36, opacity: ease(frame, [26, 44], [0, 1]) }}>
          Free for macOS · Apple Silicon &amp; Intel
        </div>
        <div
          style={{
            marginTop: 44,
            fontFamily: FONT,
            fontWeight: 700,
            fontSize: 40,
            color: "#1a0f0a",
            background: C.accent,
            borderRadius: 16,
            padding: "20px 40px",
            opacity: ease(frame, [40, 58], [0, 1]),
            transform: `scale(${interpolate(spring({ frame: frame - 40, fps, config: { damping: 200 } }), [0, 1], [0.85, 1])})`,
          }}
        >
          prole.jeffrey.build
        </div>
      </Center>
    </Content>
  );
};

/* shared bottom label chip */
const Label: React.FC<{ dur: number; children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill style={{ alignItems: "center", justifyContent: "flex-end", paddingBottom: 130 }}>
    <Chip delay={6}>{children}</Chip>
  </AbsoluteFill>
);
