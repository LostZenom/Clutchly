/**
 * /overlay layout.
 *
 * Interactivity is controlled globally by the Electron main process: when the
 * overlay is "on" the whole window is interactive; when toggled off the window
 * is click-through so the game stays fully playable. The only CSS hook here is
 * a tiny native drag handle (the match pills bar) so you can reposition the
 * overlay in either mode. The page background is forced transparent.
 */
export default function OverlayLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style
        dangerouslySetInnerHTML={{
          __html: `
            html, body { background: transparent !important; }
            .overlay-drag { -webkit-app-region: drag; }
            .overlay-drag button, .overlay-drag a, .overlay-drag input, .overlay-drag textarea, .overlay-drag select {
              -webkit-app-region: no-drag;
            }
          `,
        }}
      />
      {children}
    </>
  );
}