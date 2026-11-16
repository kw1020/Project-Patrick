import React from "react";
import { Composition } from "remotion";
import { BridgeShort as EmuShort, BRIDGE_FRAMES as EMU_FRAMES } from "./videos/emu/Bridge";
// One composition per short; copy shorts/<n>/src/videos/<name> into src/videos/ and register it here.
export const Root: React.FC = () => <>
  <Composition id="EmuShort" component={EmuShort} durationInFrames={EMU_FRAMES} fps={30} width={1080} height={1920} />
</>;
