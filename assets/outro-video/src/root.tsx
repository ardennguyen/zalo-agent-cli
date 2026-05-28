import { Composition } from "remotion";
import { Outro } from "./outro";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Outro"
      component={Outro}
      durationInFrames={150}
      fps={30}
      width={1200}
      height={700}
    />
  );
};
