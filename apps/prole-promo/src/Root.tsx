import "./index.css";
import { Composition } from "remotion";
import { ProleDemo, TOTAL } from "./ProleDemo";
import { FPS, H, W } from "./theme";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* 9:16 — Reels / TikTok / Shorts / Stories */}
      <Composition id="ProleDemo" component={ProleDemo} durationInFrames={TOTAL} fps={FPS} width={W} height={H} />
      {/* 4:5 — LinkedIn / Instagram feed */}
      <Composition id="ProleDemoLinkedIn" component={ProleDemo} durationInFrames={TOTAL} fps={FPS} width={1080} height={1350} />
    </>
  );
};
