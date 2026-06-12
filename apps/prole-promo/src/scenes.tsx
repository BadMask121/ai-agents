import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig, Easing } from "remotion";
import { C, FONT } from "./theme";
import { BrandIcon, Chip, CopyButton, Cursor, FloatingPill, SpikeChart, Toolbar, Window } from "./ui";

const ease = (f: number, a: number[], b: number[]) =>
  interpolate(f, a, b, { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });

// Fades scene CONTENT in/out over a shared background so cuts never flash black.
const Content: React.FC<{ dur: number; children: React.ReactNode }> = ({ dur, children }) => {
  const frame = useCurrentFrame();
  const opacity = Math.min(ease(frame, [0, 6], [0, 1]), ease(frame, [dur - 6, dur], [1, 0]));
  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
};

const Center: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", ...style }}>{children}</AbsoluteFill>
);

const Label: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill style={{ alignItems: "center", justifyContent: "flex-end", paddingBottom: 150 }}>
    <Chip delay={4}>{children}</Chip>
  </AbsoluteFill>
);

const CHART_W = 820;
const CHART_H = 520;

/* ---------------- 1. HOOK (45f) ---------------- */
export const SceneHook: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 200 } });
  return (
    <Content dur={dur}>
      <Center>
        <div style={{ transform: `translateY(${height * 0.08}px) scale(${interpolate(pop, [0, 1], [0.92, 1])})` }}>
          <Window width={CHART_W} height={CHART_H} title="Analytics · Traffic">
            <SpikeChart width={CHART_W} height={CHART_H - 52} draw={1} />
          </Window>
        </div>
      </Center>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "flex-start", paddingTop: height * 0.14 }}>
        <div
          style={{
            fontFamily: FONT, fontSize: 84, fontWeight: 800, color: C.text,
            letterSpacing: "-0.03em", textAlign: "center",
            opacity: ease(frame, [6, 18], [0, 1]),
            transform: `translateY(${ease(frame, [6, 18], [24, 0])}px)`,
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

/* ---------------- 1b. FLOATING BUTTON ---------------- */
export const SceneFloating: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const popIn = spring({ frame, fps, config: { damping: 200 } });
  const pressed = frame >= 30 && frame < 40;
  const t = ease(frame, [6, 28], [0, 1]); // cursor glides to the snap button
  const cursorX = interpolate(t, [0, 1], [240, 96]);
  const cursorY = interpolate(t, [0, 1], [210, 18]);
  // a quick flash as the capture fires
  const flash = ease(frame, [38, 44], [0, 0.5]) * ease(frame, [44, dur], [1, 0]);
  return (
    <Content dur={dur}>
      <Center>
        <div style={{ position: "relative", transform: `scale(${interpolate(popIn, [0, 1], [0.8, 1])})`, opacity: popIn }}>
          <FloatingPill pressed={pressed} />
          <Cursor x={cursorX} y={cursorY} />
        </div>
      </Center>
      <AbsoluteFill style={{ background: "#fff", opacity: flash }} />
      <Label>Always one click away</Label>
    </Content>
  );
};

/* ---------------- 2. SNIP (72f) ---------------- */
export const SceneSnip: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const grow = ease(frame, [10, 46], [0, 1]);
  const selX = 470, selY = 120;
  const selW = 280 * grow, selH = 300 * grow;
  const cursorX = interpolate(grow, [0, 1], [selX - 30, selX + selW + 20]);
  const cursorY = interpolate(grow, [0, 1], [selY - 30, selY + selH + 20]);
  const dim = ease(frame, [10, 30], [0, 0.6]);
  return (
    <Content dur={dur}>
      <Center>
        <div style={{ position: "relative" }}>
          <Window width={CHART_W} height={CHART_H} title="Analytics · Traffic">
            <SpikeChart width={CHART_W} height={CHART_H - 52} draw={1} />
            <AbsoluteFill style={{ background: "#000", opacity: dim }} />
            <div
              style={{
                position: "absolute", left: selX, top: selY, width: selW, height: selH,
                border: `4px solid ${C.accent}`, borderRadius: 6, background: "rgba(217,119,87,0.08)",
              }}
            />
          </Window>
          <Cursor x={cursorX} y={cursorY + 52} />
        </div>
      </Center>
      <Label>1 · Snip anything</Label>
    </Content>
  );
};

/* ---------------- 3. ANNOTATE: arrow + TEXT TOOL on the image (108f) ---------------- */
export const SceneAnnotate: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const cardW = 760, cardH = 560;
  const arrow = ease(frame, [8, 38], [0, 1]);
  const activeTool = frame < 48 ? "arrow" : "text";
  const note = "why the spike?";
  const chars = Math.round(ease(frame, [54, 92], [0, note.length]));
  const caret = frame > 50 && frame < 98 && Math.floor(frame / 8) % 2 === 0;
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
              {frame > 50 && (
                <div style={{ position: "absolute", left: 150, top: 300, fontFamily: FONT, fontWeight: 700, fontSize: 40, color: C.accent, textShadow: "0 2px 8px #000a" }}>
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
      <Label>2 · {activeTool === "arrow" ? "Mark it up" : "Write right on it"}</Label>
    </Content>
  );
};

/* ---------------- 4. COPY: the real Copy button (60f) ---------------- */
export const SceneCopy: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pressed = frame >= 12 && frame < 22;
  const shrink = ease(frame, [22, 44], [1, 0.5]);
  const lift = ease(frame, [22, 44], [0, -90]);
  const copied = spring({ frame: frame - 30, fps, config: { damping: 200 } });
  return (
    <Content dur={dur}>
      <Center>
        <div style={{ transform: `translateY(${lift}px) scale(${shrink})` }}>
          <Window width={520} height={360} title="Prole · Markup">
            <div style={{ position: "relative", width: 520, height: 308, background: C.bg }}>
              <SpikeChart width={520} height={308} draw={1} />
              <div style={{ position: "absolute", left: 120, top: 200, fontFamily: FONT, fontWeight: 700, fontSize: 30, color: C.accent }}>
                why the spike?
              </div>
            </div>
          </Window>
        </div>
        <div style={{ position: "absolute", bottom: 520, opacity: ease(frame, [2, 10], [0, 1]) * ease(frame, [30, 44], [1, 0]) }}>
          <CopyButton pressed={pressed} />
        </div>
        <div style={{ position: "absolute", bottom: 540, opacity: copied, fontFamily: FONT, fontWeight: 700, fontSize: 48, color: C.green }}>
          ✓ Copied
        </div>
      </Center>
      <Label>3 · Hit Copy</Label>
    </Content>
  );
};

/* ---------------- 5. PASTE ANYWHERE (105f) ---------------- */
export const ScenePaste: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const drop = spring({ frame: frame - 4, fps, config: { damping: 200 } });
  const reply = "That spike is your Jun 3 launch, 4× your usual traffic.";
  const chars = Math.round(ease(frame, [38, 88], [0, reply.length]));
  const apps = ["Claude", "ChatGPT", "Slack", "Mail", "anywhere"];
  return (
    <Content dur={dur}>
      <Center style={{ justifyContent: "flex-start", paddingTop: useVideoConfig().height * 0.105 }}>
        <Window width={860} height={680} title="Claude">
          <div style={{ padding: 34, display: "flex", flexDirection: "column", gap: 22 }}>
            <div style={{ alignSelf: "flex-end", transform: `translateY(${interpolate(drop, [0, 1], [40, 0])}px)`, opacity: drop }}>
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
            {frame > 34 && (
              <div style={{ alignSelf: "flex-start", maxWidth: 640, background: C.bg3, border: `1px solid ${C.border}`, borderRadius: 18, padding: "22px 26px", fontFamily: FONT, fontSize: 30, lineHeight: 1.45, color: C.text }}>
                {reply.slice(0, chars)}
              </div>
            )}
          </div>
        </Window>
      </Center>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "flex-end", paddingBottom: 210 }}>
        <div style={{ display: "flex", gap: 14, opacity: ease(frame, [72, 92], [0, 1]) }}>
          {apps.map((a, i) => (
            <div
              key={a}
              style={{
                fontFamily: FONT, fontWeight: 600, fontSize: 28,
                color: a === "anywhere" ? C.accent : C.text,
                background: C.bg2, border: `1px solid ${a === "anywhere" ? C.accent : C.border}`,
                borderRadius: 999, padding: "12px 22px",
                transform: `translateY(${ease(frame, [72 + i * 3, 92 + i * 3], [16, 0])}px)`,
              }}
            >
              {a}
            </div>
          ))}
        </div>
      </AbsoluteFill>
      <Label>Paste into Claude, or anywhere</Label>
    </Content>
  );
};

/* ---------------- 6. OUTRO (60f) ---------------- */
export const SceneOutro: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const icon = spring({ frame, fps, config: { damping: 200 } });
  const cta = spring({ frame: frame - 28, fps, config: { damping: 200 } });
  return (
    <Content dur={dur}>
      <Center>
        <div style={{ transform: `scale(${interpolate(icon, [0, 1], [0.5, 1])})`, opacity: icon, marginBottom: 50 }}>
          <BrandIcon size={180} radius={40} />
        </div>
        <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 88, color: C.text, letterSpacing: "-0.035em", textAlign: "center", lineHeight: 1.05, opacity: ease(frame, [8, 22], [0, 1]), transform: `translateY(${ease(frame, [8, 22], [24, 0])}px)` }}>
          Snip anything on screen.
          <br />
          <span style={{ color: C.accent }}>Paste it anywhere.</span>
        </div>
        <div style={{ fontFamily: FONT, fontSize: 34, color: C.dim, marginTop: 36, opacity: ease(frame, [18, 32], [0, 1]) }}>
          Free for macOS · Apple Silicon &amp; Intel
        </div>
        <div
          style={{
            marginTop: 44, fontFamily: FONT, fontWeight: 700, fontSize: 40, color: "#1a0f0a",
            background: C.accent, borderRadius: 16, padding: "20px 40px",
            opacity: ease(frame, [28, 42], [0, 1]),
            transform: `scale(${interpolate(cta, [0, 1], [0.85, 1])})`,
          }}
        >
          prole.jeffrey.build
        </div>
      </Center>
    </Content>
  );
};
