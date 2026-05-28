import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
  staticFile,
} from "remotion";

const mascot = staticFile("mascot.png");

export const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Mascot bounces in
  const mascotScale = spring({ frame, fps, config: { damping: 12 } });
  const mascotY = interpolate(mascotScale, [0, 1], [80, 0]);

  // Title fades in
  const titleOpacity = interpolate(frame, [15, 30], [0, 1], {
    extrapolateRight: "clamp",
  });
  const titleY = interpolate(frame, [15, 30], [20, 0], {
    extrapolateRight: "clamp",
  });

  // Tagline fades in
  const taglineOpacity = interpolate(frame, [30, 45], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Links stagger in
  const link1Opacity = interpolate(frame, [50, 60], [0, 1], {
    extrapolateRight: "clamp",
  });
  const link2Opacity = interpolate(frame, [60, 70], [0, 1], {
    extrapolateRight: "clamp",
  });
  const link3Opacity = interpolate(frame, [70, 80], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Pulse on CTA
  const pulse = Math.sin(frame * 0.08) * 0.03 + 1;

  return (
    <AbsoluteFill
      style={{
        background: "linear-gradient(135deg, #1a1a2e 0%, #161628 50%, #111122 100%)",
        justifyContent: "center",
        alignItems: "center",
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace',
      }}
    >
      {/* Mascot */}
      <div
        style={{
          transform: `scale(${mascotScale}) translateY(${mascotY}px)`,
          marginBottom: 24,
        }}
      >
        <Img
          src={mascot}
          style={{ width: 120, height: 120, borderRadius: 24 }}
        />
      </div>

      {/* Title */}
      <div
        style={{
          opacity: titleOpacity,
          transform: `translateY(${titleY}px)`,
          fontSize: 48,
          fontWeight: 800,
          color: "#d4c5a9",
          letterSpacing: -1,
          marginBottom: 8,
        }}
      >
        zalo-agent-cli
      </div>

      {/* Tagline */}
      <div
        style={{
          opacity: taglineOpacity,
          fontSize: 20,
          color: "#a89f91",
          marginBottom: 40,
        }}
      >
        CLI for Zalo automation — multi-account, proxy, bank transfers, QR
      </div>

      {/* Links */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          alignItems: "center",
        }}
      >
        <div
          style={{
            opacity: link1Opacity,
            transform: `scale(${frame > 90 ? pulse : 1})`,
            background: "linear-gradient(90deg, #f2cc8f, #e07a5f)",
            color: "#1a1a2e",
            padding: "12px 32px",
            borderRadius: 8,
            fontSize: 18,
            fontWeight: 700,
          }}
        >
          npm install -g zalo-agent-cli
        </div>
        <div
          style={{
            opacity: link2Opacity,
            color: "#7eb8da",
            fontSize: 16,
          }}
        >
          github.com/ardennguyen/zalo-agent-cli
        </div>
        <div
          style={{
            opacity: link3Opacity,
            color: "#f9e2af",
            fontSize: 16,
          }}
        >
          clawhub install zalo-agent
        </div>
      </div>
    </AbsoluteFill>
  );
};
