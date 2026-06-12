import "./index.css";
import { Composition } from "remotion";
import { ProleDemo, TOTAL } from "./ProleDemo";
import { FPS, H, W } from "./theme";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="ProleDemo"
        component={ProleDemo}
        durationInFrames={TOTAL}
        fps={FPS}
        width={W}
        height={H}
      />
    </>
  );
};
