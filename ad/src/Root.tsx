import { Composition } from "remotion";
import { Explainer, type ExplainerProps } from "./explainer/Explainer";
import { SLUG } from "./explainer/config";
import { loadTimeline } from "./timeline";

export const RemotionRoot: React.FC = () => (
  <>
    {/* What kitshn does, in one minute: timed by its voice-over (public/mv/explainer/spec.json). */}
    <Composition
      id="Explainer-16x9"
      component={Explainer}
      durationInFrames={1}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={{} as ExplainerProps}
      calculateMetadata={async ({ props }) => {
        const timeline = await loadTimeline(SLUG);
        return { durationInFrames: timeline.frames, fps: timeline.fps, props: { ...props, timeline } };
      }}
    />
  </>
);
