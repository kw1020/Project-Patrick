import React from "react";
import { Composition } from "remotion";
import { BridgeShort as EmuShort, BRIDGE_FRAMES as EMU_FRAMES } from "./videos/emu/Bridge";
import { BridgeShort as LastShort, BRIDGE_FRAMES as LAST_FRAMES } from "./videos/last/Bridge";
import { BridgeShort as SpeedShort, BRIDGE_FRAMES as SPEED_FRAMES } from "./videos/speed/Bridge";
import { BridgeShort as HoleShort, BRIDGE_FRAMES as HOLE_FRAMES } from "./videos/hole/Bridge";
// One composition per short: copy shorts/<n>/src/videos/<name> into src/videos/ before rendering.
export const Root: React.FC = () => <>
  <Composition id="EmuShort" component={EmuShort} durationInFrames={EMU_FRAMES} fps={30} width={1080} height={1920} />
  <Composition id="LastShort" component={LastShort} durationInFrames={LAST_FRAMES} fps={30} width={1080} height={1920} />
  <Composition id="SpeedShort" component={SpeedShort} durationInFrames={SPEED_FRAMES} fps={30} width={1080} height={1920} />
  <Composition id="HoleShort" component={HoleShort} durationInFrames={HOLE_FRAMES} fps={30} width={1080} height={1920} />
</>;
