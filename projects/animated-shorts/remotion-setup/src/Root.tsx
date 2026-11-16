import React from "react";
import { Composition, useCurrentFrame } from "remotion";
import { ThreeCanvas } from "@remotion/three";
import { BridgeShort, BRIDGE_FRAMES } from "./videos/bridge/Bridge";
const Cube: React.FC = () => { const f = useCurrentFrame(); return (
  <ThreeCanvas width={540} height={960} style={{ background: "#333" }}>
    <ambientLight intensity={1} /><directionalLight position={[2, 3, 4]} />
    <mesh rotation={[f / 20, f / 30, 0]}><boxGeometry args={[1.5, 1.5, 1.5]} /><meshStandardMaterial color="orange" /></mesh>
  </ThreeCanvas>); };
export const Root: React.FC = () => <>
  <Composition id="BridgeShort" component={BridgeShort} durationInFrames={BRIDGE_FRAMES} fps={30} width={1080} height={1920} />
  <Composition id="Cube" component={Cube} durationInFrames={60} fps={30} width={540} height={960} />
</>;
