import React from "react";
import { AbsoluteFill, Audio, interpolate, Sequence, staticFile } from "remotion";
import { SceneAnnotate, SceneCopy, SceneHook, SceneOutro, ScenePaste, SceneSnip } from "./scenes";

// Scene durations in frames (30fps). Total = 450 = 15s.
export const D = { hook: 45, snip: 72, annotate: 108, copy: 60, paste: 105, outro: 60 };
export const TOTAL = D.hook + D.snip + D.annotate + D.copy + D.paste + D.outro;

const off = {
  hook: 0,
  snip: D.hook,
  annotate: D.hook + D.snip,
  copy: D.hook + D.snip + D.annotate,
  paste: D.hook + D.snip + D.annotate + D.copy,
  outro: D.hook + D.snip + D.annotate + D.copy + D.paste,
};

export const ProleDemo: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        background:
          "radial-gradient(1000px 700px at 50% -160px, #20242d 0%, rgba(11,12,15,0) 60%)," +
          "radial-gradient(800px 700px at 100% 110%, #2a1d18 0%, rgba(11,12,15,0) 55%)," +
          "#0b0c0f",
      }}
    >
      {/* Music bed: first 15s of the track, gentle fade in/out. */}
      <Audio
        src={staticFile("demo-audio.mp3")}
        volume={(f) =>
          interpolate(f, [0, 10, TOTAL - 26, TOTAL], [0, 0.85, 0.85, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })
        }
      />
      <Sequence from={off.hook} durationInFrames={D.hook}>
        <SceneHook dur={D.hook} />
      </Sequence>
      <Sequence from={off.snip} durationInFrames={D.snip}>
        <SceneSnip dur={D.snip} />
      </Sequence>
      <Sequence from={off.annotate} durationInFrames={D.annotate}>
        <SceneAnnotate dur={D.annotate} />
      </Sequence>
      <Sequence from={off.copy} durationInFrames={D.copy}>
        <SceneCopy dur={D.copy} />
      </Sequence>
      <Sequence from={off.paste} durationInFrames={D.paste}>
        <ScenePaste dur={D.paste} />
      </Sequence>
      <Sequence from={off.outro} durationInFrames={D.outro}>
        <SceneOutro dur={D.outro} />
      </Sequence>
    </AbsoluteFill>
  );
};
