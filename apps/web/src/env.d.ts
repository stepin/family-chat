/** Version of the web client (apps/web/package.json), set by Vite. */
declare const __APP_VERSION__: string;

/** The light build of lottie-web: SVG renderer only, no expressions (M5 stickers). */
declare module 'lottie-web/build/player/esm/lottie_light.min.js' {
  export interface LottieAnimation {
    play(): void;
    pause(): void;
    stop(): void;
    goToAndStop(value: number, isFrame?: boolean): void;
    goToAndPlay(value: number, isFrame?: boolean): void;
    setSpeed(speed: number): void;
    destroy(): void;
    addEventListener(name: 'complete' | 'loopComplete' | 'DOMLoaded' | 'data_failed', cb: () => void): void;
    readonly isPaused: boolean;
  }
  export interface LottiePlayer {
    loadAnimation(params: {
      container: Element;
      renderer: 'svg';
      loop?: boolean;
      autoplay?: boolean;
      animationData: unknown;
      rendererSettings?: { preserveAspectRatio?: string; progressiveLoad?: boolean; hideOnTransparent?: boolean };
    }): LottieAnimation;
    setQuality(q: 'high' | 'medium' | 'low' | number): void;
  }
  const lottie: LottiePlayer;
  export default lottie;
}
